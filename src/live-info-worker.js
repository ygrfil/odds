import { extractNormalizedTags, normalizePureTagToken, splitTagToken } from "./tag-utils.js";

const REMOTE_COVERAGE_CACHE = new Map();
const REMOTE_TAG_COVERAGE_CACHE = new Map();
const REMOTE_TAG_BUNDLE_CACHE = new Map();
const REMOTE_TAG_BUNDLE_INFLIGHT = new Map();
const REMOTE_INFLIGHT_BY_PLAYER = new Map();

function atTagsInRange(rangeText) {
  return extractNormalizedTags(rangeText);
}

function normalizedPureTag(rangeText) {
  return normalizePureTagToken(rangeText);
}

function extractPercentAtoms(rangeText) {
  const src = String(rangeText || "").replace(/\s+/g, "");
  const raw = src.match(/\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?%/g) || [];
  const out = [];
  for (const tok of raw) {
    const nums = tok.slice(0, -1).split("-").map(Number);
    if (!nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 100)) continue;
    if (nums.length === 2 && nums[0] > nums[1]) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

function parseSimplePercentSpec(expr) {
  const s = String(expr || "").replace(/\s+/g, "");
  const top = s.match(/^(\d+(?:\.\d+)?)%$/);
  if (top) {
    const p = Number(top[1]);
    if (Number.isFinite(p) && p >= 0 && p <= 100) return { label: `${top[1]}%`, nominalPct: p };
    return null;
  }
  const band = s.match(/^(\d+(?:\.\d+)?)%-(\d+(?:\.\d+)?)%$/);
  if (band) {
    const low = Number(band[1]);
    const high = Number(band[2]);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high > 100 || low > high) return null;
    return { label: `${band[1]}%-${band[2]}%`, nominalPct: high - low };
  }
  return null;
}

function coverageCounts(cov) {
  if (!cov) return { matched: 0, total: 0, approx: false };
  if (cov.approx) {
    const matched = Number.isFinite(cov.estimatedMatched) ? cov.estimatedMatched : cov.matched;
    const total = Number.isFinite(cov.population) ? cov.population : cov.total;
    return { matched, total, approx: true };
  }
  return { matched: cov.matched, total: cov.total, approx: false };
}

function coverageText(cov) {
  if (!cov || cov.total <= 0) return "";
  if (cov.approx) {
    const pct = `~${cov.pct.toFixed(1)}%`;
    if (Number.isFinite(cov.estimatedMatched) && Number.isFinite(cov.population) && cov.population > 0) {
      return `${pct}, ~${cov.estimatedMatched.toLocaleString()}/${cov.population.toLocaleString()} combos`;
    }
    return `${pct}, ${cov.matched.toLocaleString()}/${cov.total.toLocaleString()} samples`;
  }
  return `${cov.pct.toFixed(1)}%, ${cov.matched.toLocaleString()}/${cov.total.toLocaleString()} combos`;
}

function cacheSetBounded(map, key, value, maxSize = 4000) {
  map.set(key, value);
  if (map.size > maxSize) map.clear();
}

function coverageFromBundle(bundle, tag) {
  if (!bundle || typeof bundle !== "object") return null;
  const key = String(tag || "").trim().toLowerCase();
  const cov = bundle[key];
  if (!cov || typeof cov !== "object") return null;
  return cov;
}

function canUseBackendPreview() {
  if (typeof fetch !== "function") return false;
  const proto = String(self?.location?.protocol || "");
  return proto.startsWith("http");
}

function backendOfflineError(message = "Helper backend offline") {
  const err = new Error(message);
  err.code = "BACKEND_OFFLINE";
  return err;
}

function isBackendOfflineError(err) {
  return !!(err && typeof err === "object" && err.code === "BACKEND_OFFLINE");
}

function isAbortError(err) {
  return !!(err && typeof err === "object" && err.name === "AbortError");
}

async function fetchBackendJson(path, body, signal) {
  if (!canUseBackendPreview()) throw backendOfflineError();
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw backendOfflineError();
  }
  if (res.status === 404 || res.status === 405) throw backendOfflineError();
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // leave payload null
  }
  if (!res.ok) {
    const msg = payload?.error || `Backend error (${res.status})`;
    if (res.status >= 500) throw backendOfflineError(msg);
    throw new Error(msg);
  }
  if (!payload || typeof payload !== "object") throw new Error("Invalid backend response");
  return payload;
}

async function previewRangeCoverageFast(boardText, variant, rangeText, percentileProfile = "", signal) {
  const key = `${variant}|${percentileProfile}|${String(boardText || "").trim()}|${String(rangeText || "").replace(/\s+/g, "")}`;
  if (REMOTE_COVERAGE_CACHE.has(key)) return REMOTE_COVERAGE_CACHE.get(key);
  const payload = await fetchBackendJson("/api/sim/preview/range", {
    boardText,
    variant,
    rangeText,
    percentileProfile
  }, signal);
  if (payload?.ok === false) {
    throw new Error(payload?.error || "Range: invalid expression");
  }
  const cov = payload?.coverage;
  if (!cov || typeof cov !== "object") throw new Error("Range: invalid backend response");
  cacheSetBounded(REMOTE_COVERAGE_CACHE, key, cov, 4000);
  return cov;
}

async function previewTagCoverageFast(boardText, variant, tag, signal) {
  const boardKey = String(boardText || "").trim();
  const tagToken = String(tag || "").trim().toLowerCase();
  const key = `${variant}|${boardKey}|${tagToken}`;
  if (REMOTE_TAG_COVERAGE_CACHE.has(key)) return REMOTE_TAG_COVERAGE_CACHE.get(key);
  const bundle = REMOTE_TAG_BUNDLE_CACHE.get(`${variant}|${boardKey}`);
  const bundledCov = coverageFromBundle(bundle, tagToken);
  if (bundledCov) {
    cacheSetBounded(REMOTE_TAG_COVERAGE_CACHE, key, bundledCov, 6000);
    return bundledCov;
  }
  const payload = await fetchBackendJson("/api/sim/preview/tag", {
    boardText,
    variant,
    tag
  }, signal);
  if (payload?.ok === false) {
    throw new Error(payload?.error || "Tag: invalid expression");
  }
  const cov = payload?.coverage;
  if (!cov || typeof cov !== "object") throw new Error("Tag: invalid backend response");
  cacheSetBounded(REMOTE_TAG_COVERAGE_CACHE, key, cov, 6000);
  return cov;
}

async function previewAllTagCoverageFast(boardText, variant, signal) {
  const boardKey = String(boardText || "").trim();
  const key = `${variant}|${boardKey}`;
  if (REMOTE_TAG_BUNDLE_CACHE.has(key)) return REMOTE_TAG_BUNDLE_CACHE.get(key);
  if (REMOTE_TAG_BUNDLE_INFLIGHT.has(key)) return REMOTE_TAG_BUNDLE_INFLIGHT.get(key);
  const inflight = (async () => {
    const payload = await fetchBackendJson("/api/sim/preview/tags", { boardText, variant }, signal);
    if (payload?.ok === false) throw new Error(payload?.error || "Tags: invalid board input");
    const coverageByTag = payload?.coverageByTag;
    if (!coverageByTag || typeof coverageByTag !== "object") {
      throw new Error("Tags: invalid backend response");
    }
    cacheSetBounded(REMOTE_TAG_BUNDLE_CACHE, key, coverageByTag, 1200);
    for (const [tagToken, cov] of Object.entries(coverageByTag)) {
      if (!cov || typeof cov !== "object") continue;
      const tagKey = `${variant}|${boardKey}|${String(tagToken || "").trim().toLowerCase()}`;
      cacheSetBounded(REMOTE_TAG_COVERAGE_CACHE, tagKey, cov, 6000);
    }
    return coverageByTag;
  })();
  REMOTE_TAG_BUNDLE_INFLIGHT.set(key, inflight);
  try {
    return await inflight;
  } finally {
    const current = REMOTE_TAG_BUNDLE_INFLIGHT.get(key);
    if (current === inflight) REMOTE_TAG_BUNDLE_INFLIGHT.delete(key);
  }
}

async function computeLiveInfo(rangeText, boardText, variant, percentileProfile = "", signal) {
  const expr = String(rangeText || "").trim();
  if (!expr) return { parts: [], coverage: null };

  const tags = atTagsInRange(expr);
  const isHoldem = variant === "holdem";
  const boardCards = Math.floor(String(boardText || "").replace(/\s+/g, "").length / 2);
  const pctSpec = parseSimplePercentSpec(expr);
  const tagBundlePromise = boardCards >= 3
    ? previewAllTagCoverageFast(boardText, variant, signal).catch(() => null)
    : null;
  const parts = [];
  let covExpr = null;

  try {
    covExpr = await previewRangeCoverageFast(boardText, variant, expr, percentileProfile, signal);
    const statExpr = coverageText(covExpr);
    if (statExpr) parts.push({ tone: "primary", text: `Range: ${statExpr}` });
  } catch (err) {
    if (isBackendOfflineError(err)) {
      return { parts: [{ tone: "warn", text: "Helper unavailable: backend offline." }], coverage: null };
    }
    return { parts: [{ tone: "error", text: "Range: invalid expression" }], coverage: null };
  }

  const pctAtoms = extractPercentAtoms(expr);
  if (covExpr && pctSpec && boardCards > 0 && Math.abs(covExpr.pct - pctSpec.nominalPct) >= 0.05) {
    parts.push({
      tone: "focus",
      text: `${pctSpec.label} is a preflop percentile filter; current board blockers make it ${covExpr.pct.toFixed(1)}% of remaining combos.`
    });
  }
  if (covExpr && pctAtoms.length && !pctSpec) {
    try {
      const baseExpr = pctAtoms.join(",");
      const baseCov = await previewRangeCoverageFast(boardText, variant, baseExpr, percentileProfile, signal);
      const exprCnt = coverageCounts(covExpr);
      const baseCnt = coverageCounts(baseCov);
      if (baseCnt.matched > 0) {
        const within = (exprCnt.matched * 100) / baseCnt.matched;
        const approx = exprCnt.approx || baseCnt.approx;
        const shownExpr = `${approx ? "~" : ""}${Math.max(0, Math.round(exprCnt.matched)).toLocaleString()}`;
        const shownBase = `${approx ? "~" : ""}${Math.max(0, Math.round(baseCnt.matched)).toLocaleString()}`;
        const pctLabel = pctAtoms.length === 1 ? pctAtoms[0] : "% filters";
        parts.push({ tone: "focus", text: `Inside ${pctLabel}: ${within.toFixed(1)}% (${shownExpr}/${shownBase} combos)` });
      }
    } catch (err) {
      if (isBackendOfflineError(err)) {
        parts.push({ tone: "warn", text: "Helper unavailable: backend offline." });
        return { parts, coverage: null };
      }
      // keep live info stable even for transient invalid sub-expressions
    }
  }

  if (!tags.length) return { parts, coverage: covExpr };
  const pureTag = normalizedPureTag(expr);
  const tagBundle = tagBundlePromise ? await tagBundlePromise : null;

  for (const tag of tags) {
    const tagInfo = splitTagToken(tag);
    if (!tagInfo) continue;
    if (tagInfo.base === "@overpair" && !isHoldem) {
      parts.push({ tone: "warn", text: "@overpair: Hold'em only." });
      continue;
    }
    if (boardCards < 3) {
      parts.push({ tone: "warn", text: `${tag}: needs flop+.` });
      continue;
    }
    try {
      const cov = (pureTag && pureTag === tag && covExpr && typeof covExpr === "object")
        ? covExpr
        : (coverageFromBundle(tagBundle, tag) || await previewTagCoverageFast(boardText, variant, tag, signal));
      const stat = coverageText(cov);
      let extra = "";
      if (!isHoldem && tagInfo.base === "@sd") {
        const c4 = coverageFromBundle(tagBundle, "@sd4") || await previewTagCoverageFast(boardText, variant, "@sd4", signal);
        if (cov.pct > c4.pct + 0.2) extra = " + blocker-only <4 out draws";
      }
      if (pureTag && pureTag === tag && tags.length === 1) {
        continue;
      }
      parts.push({ tone: "tag", text: `${tag}: ${stat}${extra}` });
    } catch (err) {
      if (isBackendOfflineError(err)) {
        parts.push({ tone: "warn", text: "Helper unavailable: backend offline." });
        return { parts, coverage: null };
      }
      parts.push({ tone: "warn", text: `${tag}: invalid board input` });
    }
  }
  return { parts, coverage: covExpr };
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || msg.type !== "range-live-info") return;
  const playerNum = Number(msg.playerIndex);
  const playerKey = Number.isFinite(playerNum) ? playerNum : String(msg.playerIndex ?? "");
  const prev = REMOTE_INFLIGHT_BY_PLAYER.get(playerKey);
  if (prev) prev.abort();
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  if (ctrl) REMOTE_INFLIGHT_BY_PLAYER.set(playerKey, ctrl);
  (async () => {
    let parts = [];
    let coverage = null;
    try {
      const out = await computeLiveInfo(
        msg.rangeText,
        msg.boardText,
        msg.variant,
        msg.percentileProfile,
        ctrl?.signal
      );
      parts = Array.isArray(out?.parts) ? out.parts : [];
      coverage = out?.coverage || null;
    } catch (err) {
      if (isAbortError(err)) return;
      parts = [];
      coverage = null;
    } finally {
      if (!ctrl) return;
      const current = REMOTE_INFLIGHT_BY_PLAYER.get(playerKey);
      if (current === ctrl) REMOTE_INFLIGHT_BY_PLAYER.delete(playerKey);
    }

    self.postMessage({
      type: "range-live-info-result",
      playerIndex: msg.playerIndex,
      requestId: msg.requestId,
      parts,
      coverage
    });
  })();
};
