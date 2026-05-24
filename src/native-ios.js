import { buildNativeSimRequest } from "./native-sim-request.js";
import { parseCards } from "./cards.js";
import { tryCompileRangeNativePlan } from "./parser.js";
import { rawToResult } from "./result-format.js";

const pending = new Map();
let requestSeq = 0;

function installCallback() {
  if (typeof window === "undefined") return;
  if (typeof window.__pokerOddsNativeSimComplete === "function") return;
  window.__pokerOddsNativeSimComplete = (message) => {
    const id = String(message?.id || "");
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (message?.ok) {
      entry.resolve(message.response);
    } else {
      entry.reject(new Error(message?.error || "Native iOS engine failed."));
    }
  };
}

export function canUseNativeIosSim() {
  const handler = typeof window !== "undefined"
    && window.webkit
    && window.webkit.messageHandlers
    && window.webkit.messageHandlers.nativeSim;
  return !!(window?.POKER_ODDS_LAB_IOS && handler && typeof handler.postMessage === "function");
}

function normalizeNativeRaw(raw) {
  return {
    iterations: Number(raw?.iterations || 0),
    elapsedMs: Number(raw?.elapsed_ms ?? raw?.elapsedMs ?? 0),
    wins: raw?.wins || [],
    ties: raw?.ties || [],
    losses: raw?.losses || [],
    equityShares: raw?.equity_shares ?? raw?.equityShares ?? [],
    comboCounts: raw?.combo_counts ?? raw?.comboCounts ?? [],
    comboLists: raw?.combo_lists ?? raw?.comboLists ?? [],
    classCounts: raw?.class_counts ?? raw?.classCounts ?? [],
    confidenceReached: !!(raw?.confidence_reached ?? raw?.confidenceReached),
    confidenceHalfWidthPct: Number(raw?.confidence_half_width_pct ?? raw?.confidenceHalfWidthPct ?? 0),
    confidenceLevel: Number(raw?.confidence_level ?? raw?.confidenceLevel ?? 0.95)
  };
}

function postNativeRequest(request, signal) {
  installCallback();
  const id = `native_${++requestSeq}_${Date.now().toString(36)}`;
  const requestJson = JSON.stringify(request);
  return new Promise((resolve, reject) => {
    const abort = () => {
      pending.delete(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    pending.set(id, { resolve, reject });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      window.webkit.messageHandlers.nativeSim.postMessage({ id, requestJson });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

export async function runNativeIosSimulation(config, onProgress, signal) {
  if (!canUseNativeIosSim()) {
    throw new Error("Native iOS engine bridge is not available.");
  }

  onProgress?.({ iterations: 0, elapsed: 0, ips: NaN, boardClass: "native-ios" });
  const started = performance.now();
  const nativeRequest = await buildNativeSimRequest(config);
  const response = await postNativeRequest(nativeRequest, signal);
  if (!response?.ok || !response?.raw) {
    throw new Error(response?.error || "Native iOS engine returned an invalid response.");
  }

  const raw = normalizeNativeRaw(response.raw);
  raw.method = "monte-native-rust-ios";
  const result = rawToResult(raw, { ...config, method: raw.method });
  const wallMs = performance.now() - started;
  result.backend = false;
  result.local = true;
  result.native = true;
  result.elapsedMs = wallMs;
  result.timings = {
    nativeMs: Number(raw.elapsedMs || 0),
    wallMs
  };
  return result;
}

function handSizeForVariant(variant) {
  if (variant === "holdem") return 2;
  if (variant === "plo4") return 4;
  if (variant === "plo5") return 5;
  if (variant === "plo6") return 6;
  throw new Error(`Unsupported variant: ${variant}`);
}

function chooseCount(n, k) {
  if (k > n) return 0;
  const kk = Math.min(k, n - k);
  let out = 1;
  for (let i = 1; i <= kk; i++) out = (out * (n - kk + i)) / i;
  return out;
}

export async function previewNativeIosRangeCoverage(params, signal) {
  if (!canUseNativeIosSim()) {
    throw new Error("Native iOS engine bridge is not available.");
  }

  const variant = String(params?.variant || "").trim().toLowerCase();
  const handSize = handSizeForVariant(variant);
  const board = parseCards(params?.boardText || "");
  const rangeText = String(params?.rangeText || "*").trim() || "*";
  const compact = rangeText.replace(/\s+/g, "");
  if (compact === "*") {
    const total = chooseCount(52 - board.length, handSize);
    return { matched: total, total, pct: 100, approx: false };
  }

  const percentileProfile = String(params?.percentileProfile || "").trim().toLowerCase();
  const plan = tryCompileRangeNativePlan(rangeText, variant, board, {
    percentileProfile,
    nativeExactPercentileRef: true
  });
  if (!plan) {
    throw new Error("Range cannot be compiled for the native iOS engine.");
  }

  const response = await postNativeRequest({
    mode: "preview-range",
    variant,
    iteration_cap: 1,
    hand_size: handSize,
    board,
    dead: [],
    plan
  }, signal);
  if (!response?.ok || !response?.coverage) {
    throw new Error(response?.error || "Native iOS engine returned invalid coverage.");
  }
  return response.coverage;
}
