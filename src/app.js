import { runSimulation } from "./engine.js";
import { extractNormalizedTags, splitTagToken } from "./tag-utils.js";
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
const TAG_SHORTCUT_REMOTE_CACHE = new Map();
const TAG_SHORTCUT_REMOTE_INFLIGHT = new Map();

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
  "@sd": "Straight-draw shortcut structures with 1+ outs on the current board.",
  "@sd4": "Straight-draw shortcut structures with 4+ outs on the current board.",
  "@sd8": "Straight-draw shortcut structures with 8+ outs on the current board.",
  "@sd12": "Straight-draw shortcut structures with 12+ outs on the current board."
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

function canUseBackendPreview() {
  if (typeof fetch !== "function") return false;
  const proto = String(window?.location?.protocol || "");
  return proto.startsWith("http");
}

function cacheSetBounded(map, key, value, maxSize = 2000) {
  map.set(key, value);
  if (map.size > maxSize) map.clear();
}

async function fetchTagShortcutPayload(tagToken, boardText, variant) {
  const normalizedTag = String(tagToken || "").trim().toLowerCase();
  const boardKey = String(boardText || "").trim();
  const cacheKey = `${variant}|${boardKey}|${normalizedTag}`;
  if (TAG_SHORTCUT_REMOTE_CACHE.has(cacheKey)) return TAG_SHORTCUT_REMOTE_CACHE.get(cacheKey);
  if (TAG_SHORTCUT_REMOTE_INFLIGHT.has(cacheKey)) return TAG_SHORTCUT_REMOTE_INFLIGHT.get(cacheKey);

  const inflight = (async () => {
    if (!canUseBackendPreview()) return { status: "helper-unavailable", combos: [] };
    let res;
    try {
      res = await fetch("/api/sim/preview/tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardText: boardKey,
          variant,
          tag: normalizedTag
        })
      });
    } catch {
      return { status: "helper-unavailable", combos: [] };
    }
    if (!res.ok) {
      if (res.status === 404 || res.status === 405) return { status: "helper-unavailable", combos: [] };
      return { status: "invalid-board", combos: [] };
    }
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      return { status: "invalid-board", combos: [] };
    }
    if (!payload || payload.ok === false) return { status: "invalid-board", combos: [] };
    const combos = Array.isArray(payload.combos)
      ? payload.combos.map((c) => String(c || "").trim()).filter(Boolean)
      : [];
    return { status: "ok", combos };
  })();

  TAG_SHORTCUT_REMOTE_INFLIGHT.set(cacheKey, inflight);
  try {
    const out = await inflight;
    cacheSetBounded(TAG_SHORTCUT_REMOTE_CACHE, cacheKey, out, 3000);
    return out;
  } finally {
    const current = TAG_SHORTCUT_REMOTE_INFLIGHT.get(cacheKey);
    if (current === inflight) TAG_SHORTCUT_REMOTE_INFLIGHT.delete(cacheKey);
  }
}

function shortcutTextFromPayload(payload, maxItems = 24) {
  if (!payload || typeof payload !== "object") return "invalid board";
  if (payload.status === "helper-unavailable") return "helper unavailable";
  if (payload.status !== "ok") return "invalid board";
  const combos = Array.isArray(payload.combos) ? payload.combos : [];
  if (!combos.length) return "-";
  const shown = combos.slice(0, maxItems).join(",");
  const tail = combos.length > maxItems ? ",..." : "";
  return `${shown}${tail}`;
}

async function tagShortcutPreviewText(tagToken, boardText, variant, maxItems = 24) {
  const boardLen = Math.floor(String(boardText || "").replace(/\s+/g, "").length / 2);
  if (boardLen < 3) return "needs flop+";
  if (boardLen > 5) return "invalid board";
  const payload = await fetchTagShortcutPayload(tagToken, boardText, variant);
  return shortcutTextFromPayload(payload, maxItems);
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

function rangeTagHints(rangeText, variant) {
  const uniq = extractNormalizedTags(rangeText).filter((t) => !!tagHintText(t));
  if (!uniq.length) return "";
  const lines = uniq.map((t) => `${t}: ${tagHintText(t)}`);
  return lines.join("\n");
}

async function rangeTagHintsWithShortcuts(rangeText, variant, boardText = "") {
  const uniq = extractNormalizedTags(rangeText).filter((t) => !!tagHintText(t));
  if (!uniq.length) return { text: "", comboText: "" };
  const comboSet = new Set();
  const lines = [];
  for (const tag of uniq) {
    const payload = await fetchTagShortcutPayload(tag, boardText, variant);
    const lineText = shortcutTextFromPayload(payload, 24);
    lines.push(`${tag}: ${lineText}`);
    if (payload?.status === "ok" && Array.isArray(payload.combos)) {
      for (const combo of payload.combos) comboSet.add(combo);
    }
  }
  return {
    text: lines.join("\n"),
    comboText: [...comboSet].join(",")
  };
}

async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fallback below
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
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
  renderLiveInfo(node, [{ tone: "warn", text: "Helper unavailable: backend offline." }]);
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
  const node = liveInfoState.nodeByPlayer.get(playerIndex);
  if (node) {
    if (String(rangeText || "").trim()) {
      renderLiveInfo(node, [{ tone: "primary", text: "Calculating..." }]);
    } else {
      renderLiveInfo(node, []);
    }
  }
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
  const current = String(player.range || "").trim();
  if (!current || current === "*") player.range = token;
  else player.range = `${current},${token}`;
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
  const totalMs = result.backend && result.timings && Number(result.timings.endToEndMs) > 0
    ? Number(result.timings.endToEndMs)
    : Number(result.elapsedMs || 0);
  const total = (Math.max(0, totalMs) / 1000).toFixed(2);
  el.runSummary.textContent = `${result.iterations.toLocaleString()} iterations in ${total}s`;
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
    out.push(null);
  }
  return out;
}

async function collectRangeCoverageSnapshot(config, signal) {
  if (signal?.aborted) return buildRangeCoverageSnapshot(config);
  // Avoid launching duplicate helper requests during Run; use only data
  // already computed by the live helper and cached in memory.
  return buildRangeCoverageSnapshot(config);
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
      const pop = document.createElement("div");
      pop.className = "tag-hint-popover";
      pop.textContent = "Loading tag structures...";
      pop.addEventListener("click", (e) => e.stopPropagation());
      row.appendChild(pop);
      hint.setAttribute("aria-expanded", "true");
      (async () => {
        try {
          const out = await rangeTagHintsWithShortcuts(p.range, el.variant.value, el.board.value.trim());
          await copyTextToClipboard(out.comboText);
          if (!row.contains(pop)) return;
          pop.textContent = out.text || "No @tag used in this range.";
        } catch {
          if (!row.contains(pop)) return;
          pop.textContent = rangeTagHints(p.range, el.variant.value) || "No @tag used in this range.";
        }
      })();
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
  const endToEndStarted = performance.now();

  try {
    const config = currentConfig();
    const controller = runAbortController;
    setStatus("Preparing cached range coverage...");
    const coverageStarted = performance.now();
    config.rangeCoverage = await collectRangeCoverageSnapshot(config, controller?.signal);
    const coverageMs = performance.now() - coverageStarted;
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
    result.timings = result.timings || {};
    result.timings.coverageMs = coverageMs;
    result.timings.endToEndMs = performance.now() - endToEndStarted;
    if (result.backend && typeof console !== "undefined" && typeof console.info === "function") {
      const t = result.timings;
      console.info("[native timing]", {
        coverageMs: Number(t.coverageMs || 0),
        totalWallMs: Number(t.endToEndMs || 0),
        backendTotalMs: Number(t.totalMs || 0),
        backendPrepareMs: Number(t.prepareMs || 0),
        backendSimMs: Number(t.nativeMs || 0),
        backendInitMs: Math.max(0, Number(t.totalMs || 0) - Number(t.prepareMs || 0) - Number(t.nativeMs || 0))
      });
    }
    state.lastResult = result;
    renderSummary(result);
    renderPlayers();
    const simMs = result.backend
      ? Number(result.timings.nativeMs || result.backendComputeMs || result.elapsedMs || 0)
      : Number(result.elapsedMs || 0);
    const avgIps = result.iterations / Math.max(0.001, simMs / 1000);
    const simSeconds = (simMs / 1000).toFixed(2);
    const ipsText = `${Math.round(avgIps).toLocaleString()} it/s`;
    if (result.aborted || controller.signal.aborted) {
      setStatus(`Stopped at ${result.iterations.toLocaleString()} iterations in ${simSeconds}s • ${ipsText}`);
    } else {
      setStatus(`${result.iterations.toLocaleString()} iterations in ${simSeconds}s • ${ipsText}`);
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
