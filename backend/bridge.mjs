import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  runSimulationRaw,
  runExhaustiveRaw,
  previewTagCoreCombos,
  previewTagCoverage,
  previewRangeCoverage,
  categoryMatchTag
} from "../src/sim-core.js";
import { parseCards, fullDeck } from "../src/cards.js";
import { compileRange } from "../src/parser.js";
import { makeRng } from "../src/rng.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const NATIVE_SIM_MANIFEST = path.join(PROJECT_ROOT, "native-sim", "Cargo.toml");
const NATIVE_SIM_BIN_DEFAULT = path.join(PROJECT_ROOT, "native-sim", "target", "release", "native-sim");

function variantHandSize(variant) {
  if (variant === "holdem") return 2;
  if (variant === "plo4") return 4;
  if (variant === "plo5") return 5;
  if (variant === "plo6") return 6;
  return 0;
}

function canUseExhaustive(config) {
  const need = variantHandSize(config?.variant || "");
  if (!need) return false;
  const players = Array.isArray(config?.players) ? config.players : [];
  if (players.length < 2 || players.length > 6) return false;
  for (const p of players) {
    const txt = String(p?.range || "").trim();
    if (!txt) return false;
    try {
      const cards = parseCards(txt);
      if (cards.length !== need) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function serializeRaw(raw) {
  const comboLists = (raw.comboLists || []).map((s) => Array.from(s || []));
  const comboCounts = Array.isArray(raw.comboCounts)
    ? raw.comboCounts
    : comboLists.map((arr) => arr.length);
  return {
    iterations: raw.iterations || 0,
    elapsedMs: raw.elapsedMs || 0,
    wins: raw.wins || [],
    ties: raw.ties || [],
    losses: raw.losses || [],
    equityShares: raw.equityShares || [],
    comboCounts,
    comboLists,
    classCounts: raw.classCounts || []
  };
}

async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeJson(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function comboKey(hand) {
  return hand.slice().sort((a, b) => a - b).join("-");
}

function pickDistinct(source, n, rng, out) {
  if (source.length < n) return false;
  out.length = 0;
  for (let i = 0; i < n; i++) {
    let idx = Math.floor(rng() * source.length);
    let v = source[idx];
    while (out.includes(v)) {
      idx = Math.floor(rng() * source.length);
      v = source[idx];
    }
    out.push(v);
  }
  return true;
}

function nChooseK(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let out = 1;
  for (let i = 1; i <= kk; i++) out = (out * (n - kk + i)) / i;
  return Math.round(out);
}

function enumerateRangePool(baseDeck, handSize, predicate, cap, rng) {
  const hand = new Array(handSize);
  const pool = [];
  let matched = 0;

  function rec(start, depth) {
    if (depth === handSize) {
      if (!predicate(hand)) return;
      matched++;
      const copy = hand.slice();
      if (pool.length < cap) {
        pool.push(copy);
      } else {
        const j = Math.floor(rng() * matched);
        if (j < cap) pool[j] = copy;
      }
      return;
    }
    for (let i = start; i <= baseDeck.length - (handSize - depth); i++) {
      hand[depth] = baseDeck[i];
      rec(i + 1, depth + 1);
    }
  }

  rec(0, 0);
  return { pool, matched };
}

function sampleRangePool(baseDeck, handSize, predicate, target, maxTrials, rng) {
  const pool = [];
  const seen = new Set();
  const tmp = [];
  for (let i = 0; i < maxTrials; i++) {
    if (!pickDistinct(baseDeck, handSize, rng, tmp)) break;
    if (!predicate(tmp)) continue;
    const key = comboKey(tmp);
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(tmp.slice().sort((a, b) => a - b));
    if (pool.length >= target) break;
  }
  return pool;
}

function simpleExactIfAny(rangeText, handSize) {
  try {
    const cards = parseCards(rangeText);
    if (cards.length === handSize) return cards.slice().sort((a, b) => a - b);
  } catch {
    // not exact
  }
  return null;
}

function buildPlayerSampler(config, baseDeck, boardCards, player, idx, rng) {
  const handSize = variantHandSize(config.variant);
  const rangeText = String(player.range || "*").trim() || "*";
  if (rangeText === "*") {
    return { mode: "all", hand_size: handSize };
  }

  const exact = simpleExactIfAny(rangeText, handSize);
  if (exact) {
    for (const c of exact) {
      if (!baseDeck.includes(c)) {
        throw new Error(`Player ${idx + 1} exact hand conflicts with board/dead cards.`);
      }
    }
    return { mode: "pool", hand_size: handSize, pool: [exact] };
  }

  const compiled = compileRange(rangeText, config.variant, boardCards);
  if ((compiled.weight || 0) <= 0) {
    throw new Error(`Player ${idx + 1} range appears empty on this board/dead-card setup`);
  }
  const helpers = { categoryMatch: (tag, hand, board) => categoryMatchTag(tag, hand, board) };
  const predicate = (hand) => compiled.predicate(hand, null, helpers);

  if (handSize <= 4) {
    const cap = handSize === 2 ? 15000 : 140000;
    const { pool, matched } = enumerateRangePool(baseDeck, handSize, predicate, cap, rng);
    if (!matched || pool.length === 0) {
      throw new Error(`Player ${idx + 1} range appears empty on this board/dead-card setup`);
    }
    const totalSpace = nChooseK(baseDeck.length, handSize);
    if (matched === totalSpace) {
      return { mode: "all", hand_size: handSize };
    }
    return { mode: "pool", hand_size: handSize, pool };
  }

  const target = handSize === 5 ? 32000 : 22000;
  const maxTrials = handSize === 5 ? 450000 : 550000;
  const sampled = sampleRangePool(baseDeck, handSize, predicate, target, maxTrials, rng);
  if (!sampled.length) {
    throw new Error(`Player ${idx + 1} range appears empty on this board/dead-card setup`);
  }
  return { mode: "pool", hand_size: handSize, pool: sampled };
}

function prepareNativeRequest(config, req) {
  const variant = String(config.variant || "");
  const handSize = variantHandSize(variant);
  if (!handSize) throw new Error(`Unsupported variant: ${variant}`);
  const players = Array.isArray(config.players) ? config.players : [];
  if (players.length < 2 || players.length > 6) throw new Error("At least 2 and at most 6 players required.");

  const board = parseCards(String(config.board || ""));
  const dead = parseCards(String(config.dead || ""));
  const blocked = new Set(board.concat(dead));
  const baseDeck = fullDeck().filter((c) => !blocked.has(c));

  const seed = Number(req.seed || 0x9e3779b9) >>> 0;
  const rng = makeRng(seed || 1);
  const preparedPlayers = players.map((p, i) => buildPlayerSampler(config, baseDeck, board, p, i, rng));

  return {
    variant,
    iteration_cap: Math.max(1, Number(config.iterationCap || req.iterCap || 100000)),
    board,
    dead,
    players: preparedPlayers,
    workers: Number.isFinite(Number(req.workers)) ? Math.max(1, Math.floor(Number(req.workers))) : undefined,
    seed: Number(seed || 1)
  };
}

async function runCommandWithJson(command, args, payload, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (err) {
        reject(new Error(`Invalid JSON from ${command}: ${err?.message || String(err)}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function ensureNativeBinary() {
  const forced = process.env.NATIVE_SIM_BIN ? path.resolve(process.env.NATIVE_SIM_BIN) : "";
  const candidate = forced || NATIVE_SIM_BIN_DEFAULT;
  if (fs.existsSync(candidate)) return candidate;
  if (!fs.existsSync(NATIVE_SIM_MANIFEST)) return null;

  await new Promise((resolve, reject) => {
    const child = spawn("cargo", ["build", "--release", "--manifest-path", NATIVE_SIM_MANIFEST], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || "cargo build failed"));
        return;
      }
      resolve();
    });
  });

  if (!fs.existsSync(candidate)) return null;
  return candidate;
}

function mapNativeRaw(nativeRaw) {
  return {
    iterations: nativeRaw?.iterations || 0,
    elapsedMs: nativeRaw?.elapsed_ms || 0,
    wins: nativeRaw?.wins || [],
    ties: nativeRaw?.ties || [],
    losses: nativeRaw?.losses || [],
    equityShares: nativeRaw?.equity_shares || [],
    comboCounts: nativeRaw?.combo_counts || [],
    comboLists: nativeRaw?.combo_lists || [],
    classCounts: nativeRaw?.class_counts || []
  };
}

async function runNativeSimulation(config, req) {
  const totalStart = performance.now();
  if (canUseExhaustive(config)) {
    const raw = await runExhaustiveRaw(config, {});
    return {
      ok: true,
      mode: "exact",
      raw: serializeRaw(raw),
      timings: {
        prepareMs: 0,
        nativeMs: 0,
        totalMs: performance.now() - totalStart
      }
    };
  }

  const prepStart = performance.now();
  const payload = prepareNativeRequest(config, req);
  const prepareMs = performance.now() - prepStart;

  const nativeBin = await ensureNativeBinary();
  if (!nativeBin) throw new Error("native simulator binary not found");
  const nativeStart = performance.now();
  const resp = await runCommandWithJson(nativeBin, [], payload, PROJECT_ROOT);
  const nativeMs = performance.now() - nativeStart;
  if (!resp?.ok) throw new Error(resp?.error || "native simulator failed");
  return {
    ok: true,
    mode: "monte-native",
    raw: mapNativeRaw(resp.raw || {}),
    timings: {
      prepareMs,
      nativeMs,
      totalMs: performance.now() - totalStart
    }
  };
}

async function handleRunPart(req) {
  const config = req.config || {};
  const mode = req.mode === "auto" ? (canUseExhaustive(config) ? "exact" : "monte") : String(req.mode || "monte");
  const runner = mode === "exact" ? runExhaustiveRaw : runSimulationRaw;
  const options = {
    iterCap: req.iterCap,
    seedOverride: req.seed,
    poolScale: req.poolScale,
    partitionIndex: req.partitionIndex,
    partitionCount: req.partitionCount,
    disableStabilityStop: true
  };
  const raw = await runner(config, options);
  return { ok: true, mode, raw: serializeRaw(raw) };
}

async function main() {
  const req = await readStdinJson();
  const action = String(req.action || "");
  if (action === "health") {
    writeJson({ ok: true });
    return;
  }
  if (action === "run-part") {
    writeJson(await handleRunPart(req));
    return;
  }
  if (action === "run-native") {
    const totalStart = performance.now();
    try {
      writeJson(await runNativeSimulation(req.config || {}, req));
    } catch (nativeErr) {
      // Keep backend resilient: fallback to existing JS simulation path.
      const fallback = await handleRunPart({ ...req, mode: "auto" });
      fallback.mode = fallback.mode === "exact" ? "exact" : "monte-js-fallback";
      fallback.nativeError = nativeErr?.message || String(nativeErr);
      fallback.timings = fallback.timings || {};
      fallback.timings.totalMs = performance.now() - totalStart;
      writeJson(fallback);
    }
    return;
  }
  if (action === "preview-tag") {
    const boardText = String(req.boardText || "");
    const variant = String(req.variant || "");
    const tag = String(req.tag || "");
    const combos = previewTagCoreCombos(boardText, variant, tag);
    const coverage = previewTagCoverage(boardText, variant, tag);
    writeJson({ ok: true, combos, coverage });
    return;
  }
  if (action === "preview-range") {
    const boardText = String(req.boardText || "");
    const variant = String(req.variant || "");
    const rangeText = String(req.rangeText || "");
    const coverage = previewRangeCoverage(boardText, variant, rangeText);
    writeJson({ ok: true, coverage });
    return;
  }
  writeJson({ ok: false, error: `Unsupported action: ${action}` });
  process.exitCode = 1;
}

main().catch((err) => {
  writeJson({ ok: false, error: err?.message || String(err) });
  process.exitCode = 1;
});
