import { previewTagCoverage, previewRangeCoverage } from "./sim-core.js";
import { extractNormalizedTags, normalizePureTagToken, splitTagToken } from "./tag-utils.js";

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

function computeLiveInfo(rangeText, boardText, variant, percentileProfile = "") {
  const expr = String(rangeText || "").trim();
  if (!expr) return { parts: [], coverage: null };

  const tags = atTagsInRange(expr);
  const isHoldem = variant === "holdem";
  const boardCards = Math.floor(String(boardText || "").replace(/\s+/g, "").length / 2);
  const pctSpec = parseSimplePercentSpec(expr);
  const parts = [];
  let covExpr = null;

  try {
    covExpr = previewRangeCoverage(boardText, variant, expr, { percentileProfile });
    const statExpr = coverageText(covExpr);
    if (statExpr) parts.push({ tone: "primary", text: `Range: ${statExpr}` });
  } catch {
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
      const baseCov = previewRangeCoverage(boardText, variant, baseExpr, { percentileProfile });
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
    } catch {
      // keep live info stable even for transient invalid sub-expressions
    }
  }

  if (!tags.length) return { parts, coverage: covExpr };
  const pureTag = normalizedPureTag(expr);

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
        : previewTagCoverage(boardText, variant, tag);
      const stat = coverageText(cov);
      let extra = "";
      if (!isHoldem && tagInfo.base === "@sd") {
        const c4 = previewTagCoverage(boardText, variant, "@sd4");
        if (cov.pct > c4.pct + 0.2) extra = " + blocker-only <4 out draws";
      }
      if (pureTag && pureTag === tag && tags.length === 1) {
        continue;
      }
      parts.push({ tone: "tag", text: `${tag}: ${stat}${extra}` });
    } catch {
      parts.push({ tone: "warn", text: `${tag}: invalid board input` });
    }
  }
  return { parts, coverage: covExpr };
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || msg.type !== "range-live-info") return;

  let parts = [];
  let coverage = null;
  try {
    const out = computeLiveInfo(msg.rangeText, msg.boardText, msg.variant, msg.percentileProfile);
    parts = Array.isArray(out?.parts) ? out.parts : [];
    coverage = out?.coverage || null;
  } catch {
    parts = [];
    coverage = null;
  }

  self.postMessage({
    type: "range-live-info-result",
    playerIndex: msg.playerIndex,
    requestId: msg.requestId,
    parts,
    coverage
  });
};
