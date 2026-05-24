const CLASS_NAMES = [
  "High Card",
  "Pair",
  "Two Pair",
  "Trips",
  "Straight",
  "Flush",
  "Full House",
  "Quads",
  "Straight Flush"
];

export function rawToResult(raw, config) {
  const {
    iterations: it,
    elapsedMs,
    wins,
    ties,
    losses,
    comboLists,
    classCounts,
    equityShares,
    comboCounts,
    confidenceReached,
    confidenceHalfWidthPct,
    confidenceLevel
  } = raw;
  const players = config.players;
  const n = players.length;
  const rows = players.map((p, i) => {
    const eqShare = equityShares?.[i] ?? (wins[i] + ties[i] / n);
    const equity = (eqShare / Math.max(1, it)) * 100;
    const winPct = (wins[i] / Math.max(1, it)) * 100;
    const tiePct = (ties[i] / Math.max(1, it)) * 100;
    const lossPct = (losses[i] / Math.max(1, it)) * 100;

    let comboCount = comboCounts?.[i];
    if (!Number.isFinite(comboCount)) {
      const cl = comboLists?.[i];
      if (cl instanceof Set) comboCount = cl.size;
      else if (Array.isArray(cl)) comboCount = cl.length;
      else comboCount = 0;
    }
    comboCount = Math.max(0, Math.round(Number(comboCount) || 0));

    let rangeComboCount = null;
    let rangeComboApprox = false;
    const cov = Array.isArray(config.rangeCoverage) ? config.rangeCoverage[i] : null;
    if (cov && typeof cov === "object") {
      if (cov.approx) {
        const est = Number(cov.estimatedMatched);
        const matched = Number(cov.matched);
        if (Number.isFinite(est) && est >= 0) {
          rangeComboCount = Math.round(est);
          rangeComboApprox = true;
        } else if (Number.isFinite(matched) && matched >= 0) {
          rangeComboCount = Math.round(matched);
          rangeComboApprox = true;
        }
      } else {
        const matched = Number(cov.matched);
        if (Number.isFinite(matched) && matched >= 0) {
          rangeComboCount = Math.round(matched);
        }
      }
    }
    const displayComboCount = Number.isFinite(rangeComboCount) ? rangeComboCount : comboCount;
    const comboLabel = Number.isFinite(rangeComboCount)
      ? `${rangeComboApprox ? "~" : ""}${displayComboCount.toLocaleString()}`
      : comboCount.toLocaleString();

    const classes = classCounts[i]
      .map((v, idx) => ({ name: CLASS_NAMES[idx], v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 6)
      .map((x) => `${x.name} ${((x.v / Math.max(1, it)) * 100).toFixed(2)}%`)
      .join(" | ");

    return {
      player: p.name || `P${i + 1}`,
      range: p.range,
      equity: `${equity.toFixed(2)}%`,
      win: `${winPct.toFixed(2)}%`,
      tie: `${tiePct.toFixed(2)}%`,
      loss: `${lossPct.toFixed(2)}%`,
      combos: displayComboCount,
      combosSeen: comboCount,
      combosApprox: rangeComboApprox,
      comboLabel,
      classes
    };
  });

  return {
    iterations: it,
    elapsedMs,
    aborted: !!raw.aborted,
    method: raw.method || config.method || "monte",
    variant: config.variant,
    percentileProfile: String(config.percentileProfile || ""),
    confidenceReached: !!confidenceReached,
    confidenceHalfWidthPct: Number(confidenceHalfWidthPct || 0),
    confidenceLevel: Number(confidenceLevel || 0),
    players: rows,
    input: {
      board: config.board,
      dead: config.dead
    }
  };
}
