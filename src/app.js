import { runSimulation } from "./engine.js";
import { previewTagCoreCombos, previewTagCoverage, previewRangeCoverage } from "./sim-core.js";
import { extractNormalizedTags, normalizePureTagToken, splitTagToken } from "./tag-utils.js";
import {
  normalizePercentileProfile,
  percentileProfileOptionsForVariant,
  percentileProfileLabel,
  PERCENTILE_PROFILE_OURS
} from "./percentile-profiles.js";

const state = {
  players: [
    { name: "P1", range: "*" },
    { name: "P2", range: "*" }
  ],
  focusedPlayer: 0,
  lastResult: null,
  isRunning: false
};

let runAbortController = null;
const liveInfoState = {
  worker: null,
  requestSeq: 0,
  timers: new Map(),
  latestRequestByPlayer: new Map(),
  nodeByPlayer: new Map(),
  contextByPlayer: new Map(),
  coverageByPlayer: new Map(),
  coverageReadyByPlayer: new Map()
};

const el = {
  variant: document.querySelector("#variant"),
  precision: document.querySelector("#precision"),
  orderingProfile: document.querySelector("#orderingProfile"),
  board: document.querySelector("#board"),
  dead: document.querySelector("#dead"),
  addPlayer: document.querySelector("#addPlayer"),
  removePlayer: document.querySelector("#removePlayer"),
  players: document.querySelector("#players"),
  run: document.querySelector("#run"),
  stop: document.querySelector("#stop"),
  status: document.querySelector("#status"),
  runSummary: document.querySelector("#runSummary"),
  helpOpen: document.querySelector("#helpOpen"),
  helpClose: document.querySelector("#helpClose"),
  helpModal: document.querySelector("#helpModal"),
  exportSetup: document.querySelector("#exportSetup"),
  importSetup: document.querySelector("#importSetup"),
  importFile: document.querySelector("#importFile"),
  rangePicks: document.querySelector("#rangePicks")
};

const quickPicks = [
  { label: "Top Pair", token: "@tp", group: "ready" },
  { label: "Overpair", token: "@overpair", group: "ready" },
  { label: "2 Pair", token: "@2p", group: "ready" },
  { label: "Set", token: "@set", group: "ready" },
  { label: "Straight", token: "@s", group: "ready" },
  { label: "Flush", token: "@f", group: "ready" },
  { label: "Flush Draw", token: "@fd", group: "draw" },
  { label: "Straight Draw", token: "@sd", group: "draw" },
  { label: "SD 8+ Outs", token: "@sd8", group: "draw" },
  { label: "SD 12+ Outs", token: "@sd12", group: "draw" },
  { label: "Double Suited", token: "$ds", group: "macro" },
  { label: "Single Suited", token: "$ss", group: "macro" },
  { label: "No Pair", token: "$np", group: "macro" }
];

const TAG_BASE_HINTS = {
  "@tp": "Top-pair core structure (with any side cards). In Omaha this can include stronger made hands when side cards improve the result.",
  "@overpair": "Hold'em only: pocket pair higher than top board rank.",
  "@2p": "Two-pair board-core structures (with any side cards). Example on QJT: QJ, QT, JT cores.",
  "@set": "Set/trips core structures (with any side cards).",
  "@s": "Straight core structures (with any side cards).",
  "@f": "Flush core structures (with any side cards). Omaha flush cores use exactly 2 hole + 3 board cards.",
  "@fd": "Flush-draw core structures (with any side cards).",
  "@sd": "Straight-draw core structures with 1+ outs (with any side cards).",
  "@sd4": "Straight-draw core structures with 4+ outs (with any side cards).",
  "@sd8": "Straight-draw core structures with 8+ outs (with any side cards).",
  "@sd12": "Straight-draw core structures with 12+ outs (with any side cards)."
};

const TAG_PLUS_HINTS = {
  "@tp": "Top-pair structures plus stronger made-hand structures.",
  "@overpair": "Overpair or stronger made-hand structures (Hold'em only).",
  "@2p": "Two-pair structures plus stronger made-hand structures.",
  "@set": "Set/trips structures plus stronger made-hand structures.",
  "@s": "Straight structures plus stronger made-hand structures.",
  "@f": "Flush structures plus stronger made-hand structures."
};

function tagHintText(tagToken) {
  const tagInfo = splitTagToken(tagToken);
  if (!tagInfo) return "";
  if (tagInfo.plus) return TAG_PLUS_HINTS[tagInfo.base] || "";
  return TAG_BASE_HINTS[tagInfo.base] || "";
}

function tagShortcutPreviewText(tagToken, boardText, variant, maxItems = 24) {
  const boardLen = Math.floor(String(boardText || "").replace(/\s+/g, "").length / 2);
  if (boardLen < 3) return "needs flop+";
  if (boardLen > 5) return "invalid board";
  try {
    const combos = previewTagCoreCombos(boardText, variant, tagToken);
    if (!Array.isArray(combos) || combos.length === 0) return "-";
    const shown = combos.slice(0, maxItems).join(",");
    const tail = combos.length > maxItems ? ",..." : "";
    return `${shown}${tail}`;
  } catch {
    return "invalid board";
  }
}

const PRECISION_PRESETS = {
  ci30: { target: 0.3, min: 12000, iterationCap: 500000 },
  ci20: { target: 0.2, min: 25000, iterationCap: 900000 },
  ci10: { target: 0.1, min: 60000, iterationCap: 1800000 },
  ci05: { target: 0.05, min: 120000, iterationCap: 3600000 }
};
const DEFAULT_PRECISION_PRESET = "ci20";
const DEFAULT_PERCENTILE_PROFILE = PERCENTILE_PROFILE_OURS;

function normalizePrecisionPreset(value) {
  const key = String(value || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PRECISION_PRESETS, key)) return key;
  if (key === "cap") return DEFAULT_PRECISION_PRESET;
  return DEFAULT_PRECISION_PRESET;
}

function precisionPresetFromTarget(targetPct) {
  const target = Number(targetPct);
  if (!Number.isFinite(target) || target <= 0) return DEFAULT_PRECISION_PRESET;
  const keys = Object.keys(PRECISION_PRESETS);
  let best = keys[0] || DEFAULT_PRECISION_PRESET;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const k of keys) {
    const diff = Math.abs(PRECISION_PRESETS[k].target - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = k;
    }
  }
  return best;
}

function currentOrderingProfile(variant = el.variant.value) {
  return normalizePercentileProfile(variant, el.orderingProfile?.value || DEFAULT_PERCENTILE_PROFILE);
}

function syncOrderingProfileControl() {
  if (!el.orderingProfile) return;
  const variant = el.variant.value;
  const options = percentileProfileOptionsForVariant(variant);
  const requested = el.orderingProfile.value || DEFAULT_PERCENTILE_PROFILE;
  const normalized = normalizePercentileProfile(variant, requested);
  el.orderingProfile.innerHTML = "";
  for (const opt of options) {
    const node = document.createElement("option");
    node.value = opt.id;
    node.textContent = opt.label;
    el.orderingProfile.appendChild(node);
  }
  el.orderingProfile.value = normalized;
  el.orderingProfile.disabled = options.length <= 1;
  el.orderingProfile.title = percentileProfileLabel(normalized);
}

function rangeTagHints(rangeText, variant, boardText = "", showShortcuts = false) {
  const uniq = extractNormalizedTags(rangeText).filter((t) => !!tagHintText(t));
  if (!uniq.length) return "";
  const gameRule = variant === "holdem"
    ? "Game rule: Hold'em hand evaluation can use any 5-card combination."
    : "Game rule: Omaha hand evaluation always uses exactly 2 hole cards + 3 board cards.";
  const plusRule = "Tip: use '+' only on ready-hand tags (@tp, @overpair, @2p, @set, @s, @f) to include stronger made hands.";
  const lines = uniq.map((t) => showShortcuts
    ? `${t}: ${tagShortcutPreviewText(t, boardText, variant)}`
    : `${t}: ${tagHintText(t)}`);
  return `${lines.join("\n")}\n${plusRule}\n${gameRule}`;
}

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

function rangeLiveInfo(
  rangeText,
  boardText = el.board.value.trim(),
  variant = el.variant.value,
  percentileProfile = currentOrderingProfile(variant)
) {
  const expr = String(rangeText || "").trim();
  if (!expr) return [];

  const tags = atTagsInRange(expr);
  const boardCards = Math.floor(String(boardText).replace(/\s+/g, "").length / 2);
  const isHoldem = variant === "holdem";
  const pctSpec = parseSimplePercentSpec(expr);
  const parts = [];
  let covExpr = null;

  try {
    covExpr = previewRangeCoverage(boardText, variant, expr, { percentileProfile });
    const statExpr = coverageText(covExpr);
    if (statExpr) parts.push({ tone: "primary", text: `Range: ${statExpr}` });
  } catch {
    parts.push({ tone: "error", text: "Range: invalid expression" });
    return parts;
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
      // ignore subset stats for invalid percent filter expression
    }
  }

  if (!tags.length) return parts;
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
    } else {
      try {
        const cov = (pureTag && pureTag === tag && covExpr && typeof covExpr === "object")
          ? covExpr
          : previewTagCoverage(boardText, variant, tag);
        const stat = coverageText(cov);
        let extra = "";
        if (!isHoldem && tagInfo.base === "@sd") {
          const c4 = previewTagCoverage(boardText, variant, "@sd4");
          if (cov.pct > c4.pct + 0.2) {
            extra = " + blocker-only <4 out draws";
          }
        }
        if (pureTag && pureTag === tag && tags.length === 1) {
          continue;
        }
        parts.push({ tone: "tag", text: `${tag}: ${stat}${extra}` });
      } catch {
        parts.push({ tone: "warn", text: `${tag}: invalid board input` });
      }
    }
  }
  return parts;
}

function renderLiveInfo(node, parts) {
  node.innerHTML = "";
  const chunks = Array.isArray(parts) ? parts.filter((p) => p && p.text) : [];
  if (!chunks.length) {
    node.style.display = "none";
    return;
  }
  for (const p of chunks) {
    const span = document.createElement("span");
    span.className = `live-chip live-${p.tone || "tag"}`;
    span.textContent = p.text;
    node.appendChild(span);
  }
  node.style.display = "";
}

function initLiveInfoWorker() {
  if (typeof Worker === "undefined") return;
  try {
    const worker = new Worker(new URL("./live-info-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (event) => {
      const msg = event.data;
      if (!msg || msg.type !== "range-live-info-result") return;
      const playerIndex = Number(msg.playerIndex);
      const requestId = Number(msg.requestId);
      if (liveInfoState.latestRequestByPlayer.get(playerIndex) !== requestId) return;
      const node = liveInfoState.nodeByPlayer.get(playerIndex);
      if (!node) return;
      renderLiveInfo(node, Array.isArray(msg.parts) ? msg.parts : []);
      if (msg.coverage && typeof msg.coverage === "object") {
        liveInfoState.coverageByPlayer.set(playerIndex, msg.coverage);
      } else {
        liveInfoState.coverageByPlayer.delete(playerIndex);
      }
      liveInfoState.coverageReadyByPlayer.set(playerIndex, requestId);
    };
    worker.onerror = () => {
      worker.terminate();
      liveInfoState.worker = null;
    };
    liveInfoState.worker = worker;
  } catch {
    liveInfoState.worker = null;
  }
}

function pruneLiveInfoState() {
  const maxPlayers = state.players.length;
  for (const [idx, timer] of liveInfoState.timers.entries()) {
    if (idx >= maxPlayers) {
      clearTimeout(timer);
      liveInfoState.timers.delete(idx);
    }
  }
  for (const idx of liveInfoState.latestRequestByPlayer.keys()) {
    if (idx >= maxPlayers) liveInfoState.latestRequestByPlayer.delete(idx);
  }
  for (const idx of liveInfoState.contextByPlayer.keys()) {
    if (idx >= maxPlayers) liveInfoState.contextByPlayer.delete(idx);
  }
  for (const idx of liveInfoState.coverageByPlayer.keys()) {
    if (idx >= maxPlayers) liveInfoState.coverageByPlayer.delete(idx);
  }
  for (const idx of liveInfoState.coverageReadyByPlayer.keys()) {
    if (idx >= maxPlayers) liveInfoState.coverageReadyByPlayer.delete(idx);
  }
}

function dispatchLiveInfoUpdate(playerIndex) {
  liveInfoState.timers.delete(playerIndex);
  const ctx = liveInfoState.contextByPlayer.get(playerIndex);
  const node = liveInfoState.nodeByPlayer.get(playerIndex);
  if (!ctx || !node) return;

  const requestId = ++liveInfoState.requestSeq;
  liveInfoState.latestRequestByPlayer.set(playerIndex, requestId);

  if (liveInfoState.worker) {
    liveInfoState.worker.postMessage({
      type: "range-live-info",
      playerIndex,
      requestId,
      boardText: ctx.boardText,
      variant: ctx.variant,
      percentileProfile: ctx.percentileProfile,
      rangeText: ctx.rangeText
    });
    return;
  }

  setTimeout(() => {
    if (liveInfoState.latestRequestByPlayer.get(playerIndex) !== requestId) return;
    const parts = rangeLiveInfo(ctx.rangeText, ctx.boardText, ctx.variant, ctx.percentileProfile);
    const latestNode = liveInfoState.nodeByPlayer.get(playerIndex);
    if (!latestNode) return;
    renderLiveInfo(latestNode, parts);
  }, 0);
}

function queueLiveInfoUpdate(playerIndex, rangeText, immediate = false) {
  const variant = el.variant.value;
  liveInfoState.contextByPlayer.set(playerIndex, {
    rangeText: String(rangeText || ""),
    boardText: el.board.value.trim(),
    variant,
    percentileProfile: currentOrderingProfile(variant)
  });
  liveInfoState.coverageByPlayer.delete(playerIndex);
  liveInfoState.coverageReadyByPlayer.delete(playerIndex);
  const prevTimer = liveInfoState.timers.get(playerIndex);
  if (prevTimer) clearTimeout(prevTimer);
  const delay = immediate ? 0 : 180;
  const timer = setTimeout(() => dispatchLiveInfoUpdate(playerIndex), delay);
  liveInfoState.timers.set(playerIndex, timer);
}

function saveLocal() {
  const precision = normalizePrecisionPreset(el.precision?.value);
  if (el.precision) el.precision.value = precision;
  const percentileProfile = currentOrderingProfile(el.variant.value);
  localStorage.setItem("poker-odds-lab-state", JSON.stringify({
    variant: el.variant.value,
    precision,
    percentileProfile,
    board: el.board.value,
    dead: el.dead.value,
    players: state.players
  }));
}

function loadLocal() {
  try {
    const raw = localStorage.getItem("poker-odds-lab-state");
    if (!raw) return;
    const s = JSON.parse(raw);
    el.variant.value = s.variant || "holdem";
    if (el.precision) el.precision.value = normalizePrecisionPreset(s.precision);
    if (el.orderingProfile) el.orderingProfile.value = s.percentileProfile || DEFAULT_PERCENTILE_PROFILE;
    el.board.value = s.board || "";
    el.dead.value = s.dead || "";
    if (Array.isArray(s.players) && s.players.length >= 2) {
      state.players = s.players.slice(0, 6).map((p, i) => ({
        name: p.name || `P${i + 1}`,
        range: p.range || "*"
      }));
    }
  } catch {
    // ignore corrupt local storage
  }
}

function renderQuickPicks() {
  el.rangePicks.innerHTML = "";
  let lastGroup = "";
  for (const p of quickPicks) {
    if (lastGroup && p.group !== lastGroup) {
      const sep = document.createElement("span");
      sep.className = "range-pick-sep";
      sep.setAttribute("aria-hidden", "true");
      el.rangePicks.appendChild(sep);
    }
    lastGroup = p.group;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.label;
    if (p.group) b.classList.add(`pick-${p.group}`);
    b.addEventListener("click", () => applyQuickPick(p.token));
    el.rangePicks.appendChild(b);
  }
}

function applyQuickPick(token) {
  const idx = Math.max(0, Math.min(state.players.length - 1, state.focusedPlayer));
  const player = state.players[idx];
  if (!player) return;
  if (!player.range || player.range.trim() === "*") player.range = token;
  else player.range = `${player.range}:${token}`;
  renderPlayers();
  saveLocal();
}

function openHelp() {
  el.helpModal.classList.remove("hidden");
}

function closeHelp() {
  el.helpModal.classList.add("hidden");
}

function setStatus(msg) {
  el.status.textContent = msg;
}

function renderSummary(result) {
  if (!result || !result.players?.length) {
    el.runSummary.textContent = "";
    return;
  }
  const engine = result.backend ? "NATIVE BACKEND" : "BROWSER";
  const total = (result.elapsedMs / 1000).toFixed(2);
  let extra = "";
  if (result.backend && result.timings) {
    const prep = Number(result.timings.prepareMs || 0);
    const sim = Number(result.timings.nativeMs || result.backendComputeMs || 0);
    if (prep > 0 || sim > 0) {
      extra = ` • prep ${(prep / 1000).toFixed(2)}s • sim ${(sim / 1000).toFixed(2)}s`;
    }
  }
  let confText = "";
  if (Number(result.confidenceLevel) > 0 && Number.isFinite(Number(result.confidenceHalfWidthPct))) {
    const level = Math.round(Number(result.confidenceLevel) * 100);
    const half = Number(result.confidenceHalfWidthPct);
    confText = ` • CI${level} ±${half.toFixed(3)}%${result.confidenceReached ? " reached" : ""}`;
  }
  const profileText = result.percentileProfile ? ` • ${percentileProfileLabel(result.percentileProfile)}` : "";
  el.runSummary.textContent = `${result.iterations.toLocaleString()} iterations in ${total}s • ${result.variant.toUpperCase()}${profileText} • ${String(result.method || "monte").toUpperCase()} • ${engine}${extra}${confText}`;
}

function numericPercent(value) {
  const n = Number(String(value || "").replace("%", ""));
  return Number.isFinite(n) ? n : 0;
}

function equityTier(index, allRows) {
  if (!Array.isArray(allRows) || allRows.length < 2) return "eq-mid";
  const ranked = allRows
    .map((r, i) => ({ i, equity: numericPercent(r?.equity) }))
    .sort((a, b) => b.equity - a.equity);
  const pos = ranked.findIndex((x) => x.i === index);
  if (pos === 0) return "eq-high";
  if (pos === ranked.length - 1) return "eq-low";
  return "eq-mid";
}

function appendMetricChip(parent, label, value, className) {
  const chip = document.createElement("span");
  chip.className = className;
  const strong = document.createElement("strong");
  strong.textContent = label;
  chip.appendChild(strong);
  chip.append(document.createTextNode(` ${value}`));
  parent.appendChild(chip);
}

function playerOutputRow(row, rowIndex, allRows) {
  const wrap = document.createElement("div");
  wrap.className = "player-output";

  if (!row) {
    wrap.textContent = "No result yet.";
    return wrap;
  }

  const eqClass = `result-chip chip-eq ${equityTier(rowIndex, allRows)}`;
  appendMetricChip(wrap, "Eq", row.equity, eqClass);
  appendMetricChip(wrap, "W", row.win, "result-chip chip-win");
  appendMetricChip(wrap, "T", row.tie, "result-chip chip-tie");
  appendMetricChip(wrap, "L", row.loss, "result-chip chip-loss");
  appendMetricChip(wrap, "Combos", row.comboLabel || row.combos, "result-chip chip-combos");

  const classes = document.createElement("div");
  classes.className = "player-classes";
  classes.textContent = row.classes || "";
  wrap.appendChild(classes);
  return wrap;
}

function coverageForConfigPlayer(config, playerIndex) {
  const boardText = String(config.board || "").trim();
  const variant = String(config.variant || "");
  const percentileProfile = String(config.percentileProfile || "");
  const players = Array.isArray(config.players) ? config.players : [];
  const rangeText = String(players[playerIndex]?.range || "*");
  const ctx = liveInfoState.contextByPlayer.get(playerIndex);
  const cov = liveInfoState.coverageByPlayer.get(playerIndex);
  const contextMatches = !!ctx
    && String(ctx.rangeText || "").trim() === rangeText
    && String(ctx.boardText || "") === boardText
    && String(ctx.variant || "") === variant
    && String(ctx.percentileProfile || "") === percentileProfile;
  if (contextMatches && cov && typeof cov === "object") return cov;
  return null;
}

function buildRangeCoverageSnapshot(config) {
  const players = Array.isArray(config.players) ? config.players : [];
  const out = [];
  for (let i = 0; i < players.length; i++) {
    const cached = coverageForConfigPlayer(config, i);
    if (cached) {
      out.push(cached);
      continue;
    }
    // Keep run button responsive: if worker is available, avoid heavy sync
    // exact recomputation on the main thread.
    if (liveInfoState.worker) {
      out.push(null);
      continue;
    }
    try {
      const boardText = String(config.board || "").trim();
      const variant = String(config.variant || "");
      const percentileProfile = String(config.percentileProfile || "");
      const rangeText = String(players[i]?.range || "*");
      out.push(previewRangeCoverage(boardText, variant, rangeText, { percentileProfile }));
    } catch {
      out.push(null);
    }
  }
  return out;
}

function waitForCoverage(config, playerIndex, signal, baselineReadyId = 0, timeoutMs = 0) {
  const started = performance.now();
  return new Promise((resolve) => {
    const poll = () => {
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      const cov = coverageForConfigPlayer(config, playerIndex);
      if (cov) {
        resolve(cov);
        return;
      }
      const readyId = Number(liveInfoState.coverageReadyByPlayer.get(playerIndex) || 0);
      if (readyId && readyId !== baselineReadyId) {
        resolve(null);
        return;
      }
      if (timeoutMs > 0 && performance.now() - started >= timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(poll, 40);
    };
    poll();
  });
}

async function collectRangeCoverageSnapshot(config, signal) {
  const snapshot = buildRangeCoverageSnapshot(config);
  if (!liveInfoState.worker) return snapshot;
  if (signal?.aborted) return snapshot;
  const players = Array.isArray(config.players) ? config.players : [];
  const missing = [];
  for (let i = 0; i < players.length; i++) {
    if (!snapshot[i]) missing.push(i);
  }
  if (!missing.length) return snapshot;
  const readyBaseline = new Map();
  for (const i of missing) {
    readyBaseline.set(i, Number(liveInfoState.coverageReadyByPlayer.get(i) || 0));
    queueLiveInfoUpdate(i, players[i]?.range || "*", true);
  }
  const resolved = await Promise.all(
    missing.map((i) => waitForCoverage(config, i, signal, readyBaseline.get(i) || 0, 0))
  );
  for (let j = 0; j < missing.length; j++) {
    snapshot[missing[j]] = resolved[j];
  }
  return snapshot;
}

function renderPlayers() {
  el.players.innerHTML = "";
  liveInfoState.nodeByPlayer.clear();
  const results = state.lastResult?.players || [];

  state.players.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "player-row";

    const main = document.createElement("div");
    main.className = "player-main";

    const tag = document.createElement("span");
    tag.className = "player-tag";
    tag.textContent = `P${i + 1}`;

    const range = document.createElement("input");
    range.className = "player-range-input";
    range.type = "text";
    range.value = p.range;
    range.placeholder = "Range syntax, e.g. AA,AK$s,15%";
    range.addEventListener("focus", () => {
      state.focusedPlayer = i;
    });

    main.appendChild(tag);
    main.appendChild(range);
    const hint = document.createElement("button");
    hint.type = "button";
    hint.className = "tag-hint";
    hint.textContent = "?";
    hint.setAttribute("aria-expanded", "false");
    hint.addEventListener("click", (event) => {
      event.stopPropagation();
      const existing = row.querySelector(".tag-hint-popover");
      document.querySelectorAll(".tag-hint-popover").forEach((n) => n.remove());
      document.querySelectorAll(".tag-hint[aria-expanded='true']").forEach((n) => n.setAttribute("aria-expanded", "false"));
      if (existing) return;
      const help = rangeTagHints(p.range, el.variant.value, el.board.value.trim(), true);

      const pop = document.createElement("div");
      pop.className = "tag-hint-popover";
      pop.textContent = help || "No @tag used in this range.";
      pop.addEventListener("click", (e) => e.stopPropagation());
      row.appendChild(pop);
      hint.setAttribute("aria-expanded", "true");
    });
    main.appendChild(hint);
    row.appendChild(main);
    const info = document.createElement("div");
    info.className = "player-live-note";
    row.appendChild(info);
    liveInfoState.nodeByPlayer.set(i, info);
    const refreshDerived = (immediate = false) => {
      const h = rangeTagHints(p.range, el.variant.value);
      hint.classList.toggle("is-empty", !h);
      queueLiveInfoUpdate(i, p.range, immediate);
    };
    range.addEventListener("input", () => {
      p.range = range.value;
      saveLocal();
      refreshDerived(false);
    });
    refreshDerived(false);
    row.appendChild(playerOutputRow(results[i], i, results));
    el.players.appendChild(row);
  });
  pruneLiveInfoState();
}

function currentConfig() {
  const preset = normalizePrecisionPreset(el.precision?.value);
  if (el.precision) el.precision.value = preset;
  const variant = el.variant.value;
  const percentileProfile = currentOrderingProfile(variant);
  if (el.orderingProfile) el.orderingProfile.value = percentileProfile;
  const conf = PRECISION_PRESETS[preset] || PRECISION_PRESETS[DEFAULT_PRECISION_PRESET];
  return {
    variant,
    percentileProfile,
    precision: preset,
    iterationCap: conf.iterationCap,
    confidenceTargetPct: conf.target,
    confidenceMinIterations: conf.min,
    confidenceLevel: 0.95,
    board: el.board.value.trim(),
    dead: el.dead.value.trim(),
    players: state.players.map((p, i) => ({
      name: p.name?.trim() || `P${i + 1}`,
      range: p.range?.trim() || "*"
    }))
  };
}

async function run() {
  if (state.isRunning) return;
  state.isRunning = true;
  el.run.disabled = true;
  el.stop.disabled = false;
  runAbortController = new AbortController();

  try {
    const config = currentConfig();
    const controller = runAbortController;
    setStatus("Preparing exact range coverage...");
    config.rangeCoverage = await collectRangeCoverageSnapshot(config, controller?.signal);
    if (!controller || controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    setStatus("Running simulation...");
    const result = await runSimulation(config, (p) => {
      const ips = Number(p.ips);
      if (Number.isFinite(ips) && ips > 0 && Number(p.iterations) > 0) {
        setStatus(`Iterations: ${p.iterations.toLocaleString()} | ${Math.round(ips).toLocaleString()} it/s | ${p.elapsed.toFixed(2)}s`);
      } else {
        setStatus(`Running... preparing/evaluating ranges | ${p.elapsed.toFixed(2)}s`);
      }
    }, controller.signal);
    state.lastResult = result;
    renderSummary(result);
    renderPlayers();
    const avgIps = result.iterations / Math.max(0.001, result.elapsedMs / 1000);
    const ciSuffix = result.confidenceReached ? " CI target reached." : "";
    if (result.aborted || controller.signal.aborted) {
      setStatus(`Stopped at ${result.iterations.toLocaleString()} iterations in ${(result.elapsedMs / 1000).toFixed(2)}s (${Math.round(avgIps).toLocaleString()} it/s avg).`);
    } else {
      setStatus(`Done. ${result.iterations.toLocaleString()} iterations in ${(result.elapsedMs / 1000).toFixed(2)}s (${Math.round(avgIps).toLocaleString()} it/s avg).${ciSuffix}`);
    }
  } catch (err) {
    if (runAbortController?.signal?.aborted || err?.name === "AbortError") setStatus("Stopped.");
    else setStatus(`Error: ${err.message || String(err)}`);
  } finally {
    state.isRunning = false;
    runAbortController = null;
    el.run.disabled = false;
    el.stop.disabled = true;
  }
}

function stopRun() {
  if (!state.isRunning || !runAbortController) return;
  runAbortController.abort();
  setStatus("Stopping...");
}

function exportSetup() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    setup: currentConfig(),
    result: state.lastResult
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `poker-odds-lab-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importSetup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(String(reader.result || "{}"));
      const setup = payload.setup || payload;
      if (!setup.players || setup.players.length < 2) throw new Error("Invalid setup file");

      el.variant.value = setup.variant || "holdem";
      if (el.precision) {
        el.precision.value = normalizePrecisionPreset(setup.precision || precisionPresetFromTarget(setup.confidenceTargetPct));
      }
      if (el.orderingProfile) {
        el.orderingProfile.value = setup.percentileProfile || DEFAULT_PERCENTILE_PROFILE;
      }
      syncOrderingProfileControl();
      el.board.value = setup.board || "";
      el.dead.value = setup.dead || "";
      state.players = setup.players.slice(0, 6).map((p, i) => ({
        name: p.name || `P${i + 1}`,
        range: p.range || "*"
      }));

      state.lastResult = payload.result || null;
      renderSummary(state.lastResult);
      renderPlayers();
      saveLocal();
      setStatus("Setup imported.");
    } catch (err) {
      setStatus(`Import failed: ${err.message || String(err)}`);
    }
  };
  reader.readAsText(file);
}

function wire() {
  document.addEventListener("click", () => {
    document.querySelectorAll(".tag-hint-popover").forEach((n) => n.remove());
    document.querySelectorAll(".tag-hint[aria-expanded='true']").forEach((n) => n.setAttribute("aria-expanded", "false"));
  });

  el.addPlayer.addEventListener("click", () => {
    if (state.isRunning) return;
    if (state.players.length >= 6) {
      setStatus("Max 6 players.");
      return;
    }
    state.players.push({ name: `P${state.players.length + 1}`, range: "*" });
    renderPlayers();
    saveLocal();
  });

  el.removePlayer.addEventListener("click", () => {
    if (state.isRunning) return;
    if (state.players.length <= 2) {
      setStatus("Minimum 2 players.");
      return;
    }
    state.players.pop();
    renderPlayers();
    saveLocal();
  });

  el.run.addEventListener("click", run);
  el.stop.addEventListener("click", stopRun);
  el.helpOpen.addEventListener("click", openHelp);
  el.helpClose.addEventListener("click", closeHelp);
  el.helpModal.addEventListener("click", (event) => {
    if (event.target === el.helpModal) closeHelp();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.helpModal.classList.contains("hidden")) closeHelp();
  });

  el.exportSetup.addEventListener("click", exportSetup);
  el.importSetup.addEventListener("click", () => el.importFile.click());
  el.importFile.addEventListener("change", () => {
    const file = el.importFile.files?.[0];
    if (file) importSetup(file);
    el.importFile.value = "";
  });

  [el.variant, el.precision, el.orderingProfile, el.board, el.dead].forEach((node) => {
    if (!node) return;
    node.addEventListener("input", saveLocal);
  });
  el.variant.addEventListener("change", () => {
    syncOrderingProfileControl();
    saveLocal();
    renderPlayers();
  });
  if (el.orderingProfile) {
    el.orderingProfile.addEventListener("change", () => {
      syncOrderingProfileControl();
      saveLocal();
      renderPlayers();
    });
  }
  el.board.addEventListener("input", renderPlayers);
}

loadLocal();
syncOrderingProfileControl();
initLiveInfoWorker();
renderQuickPicks();
renderSummary(state.lastResult);
renderPlayers();
wire();
window.addEventListener("beforeunload", () => {
  if (liveInfoState.worker) liveInfoState.worker.terminate();
});
el.stop.disabled = true;
setStatus("Idle.");
