export function extractPercentAtoms(rangeText) {
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

export function parseSimplePercentSpec(expr) {
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

export function coverageCounts(cov) {
  if (!cov) return { matched: 0, total: 0, approx: false };
  if (cov.approx) {
    const matched = Number.isFinite(cov.estimatedMatched) ? cov.estimatedMatched : cov.matched;
    const total = Number.isFinite(cov.population) ? cov.population : cov.total;
    return { matched, total, approx: true };
  }
  return { matched: cov.matched, total: cov.total, approx: false };
}

export function coverageText(cov) {
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

export function cacheSetBounded(map, key, value, maxSize) {
  map.set(key, value);
  if (map.size > maxSize) map.clear();
}
