import { runSimulation } from "./engine.js";
import { validateRangeSyntax } from "./parser.js";
import { extractNormalizedTags, splitTagToken } from "./tag-utils.js";
import {
  normalizePercentileProfile,
  percentileProfileOptionsForVariant,
  percentileProfileLabel,
  PERCENTILE_PROFILE_OURS
} from "./percentile-profiles.js";

const DEFAULT_PLAYER_RANGE = "30%";
const state = {
  players: [
    { name: "P1", range: DEFAULT_PLAYER_RANGE },
    { name: "P2", range: DEFAULT_PLAYER_RANGE }
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
const bombpotState = {
  running: false,
  requestId: 0,
  progressToken: "",
  progressTimer: null
};
const BOMBPOT_RUNTIME_MULTIPLIER = 1.6;
const BOMBPOT_RUNTIME_MIN_MS = 20_000;
const BOMBPOT_RUNTIME_MAX_MS = 900_000;
const TAG_SHORTCUT_REMOTE_CACHE = new Map();
const TAG_SHORTCUT_REMOTE_INFLIGHT = new Map();

const el = {
  variant: document.querySelector("#variant"),
  precision: document.querySelector("#precision"),
  orderingProfile: document.querySelector("#orderingProfile"),
  board: document.querySelector("#board"),
  boardCardKeyboard: document.querySelector("#boardCardKeyboard"),
  deadToggle: document.querySelector("#deadToggle"),
  deadWrap: document.querySelector("#deadWrap"),
  dead: document.querySelector("#dead"),
  deadCardKeyboard: document.querySelector("#deadCardKeyboard"),
  boardPretty: document.querySelector("#boardPretty"),
  addPlayer: document.querySelector("#addPlayer"),
  removePlayer: document.querySelector("#removePlayer"),
  players: document.querySelector("#players"),
  run: document.querySelector("#run"),
  stop: document.querySelector("#stop"),
  status: document.querySelector("#status"),
  helpOpen: document.querySelector("#helpOpen"),
  helpClose: document.querySelector("#helpClose"),
  helpModal: document.querySelector("#helpModal"),
  bombpotModal: document.querySelector("#bombpotModal"),
  bombpotClose: document.querySelector("#bombpotClose"),
  exportSetup: document.querySelector("#exportSetup"),
  importSetup: document.querySelector("#importSetup"),
  clearAll: document.querySelector("#clearAll"),
  importFile: document.querySelector("#importFile"),
  rangePicks: document.querySelector("#rangePicks"),
  bombpotRun: document.querySelector("#bombpotRun"),
  bombpotStatus: document.querySelector("#bombpotStatus"),
  bombpotMeta: document.querySelector("#bombpotMeta"),
  bombpotProgressWrap: document.querySelector("#bombpotProgressWrap"),
  bombpotProgressBar: document.querySelector("#bombpotProgressBar"),
  bombpotResult: document.querySelector("#bombpotResult"),
  cardKeyboard: document.querySelector("#cardKeyboard"),
  cardKeyboardPanel: document.querySelector("#cardKeyboardPanel"),
  cardKeyboardTarget: document.querySelector("#cardKeyboardTarget"),
  cardKeyboardSuits: document.querySelector("#cardKeyboardSuits"),
  cardKeyboardRanks: document.querySelector("#cardKeyboardRanks"),
  cardKeyboardClose: document.querySelector("#cardKeyboardClose")
};
const uiState = {
  rangeInputsByPlayer: new Map(),
  rangeWindowsByPlayer: new Map(),
  refreshByPlayer: new Map(),
  deadVisible: false
};
const runActivityState = {
  timer: null,
  startedAt: 0,
  phase: "",
  iterations: 0,
  rate: NaN,
  detail: ""
};
const validationPreviewState = {
  timers: new Map(),
  requestSeqByPlayer: new Map()
};
const cardKeyboardState = {
  suit: "s",
  target: null
};
const SUIT_SYMBOLS = Object.freeze({
  c: "♣",
  d: "♦",
  h: "♥",
  s: "♠"
});
const SUIT_SYMBOL_CLASSES = Object.freeze({
  "♣": "suit-club",
  "♦": "suit-diamond",
  "♥": "suit-heart",
  "♠": "suit-spade"
});
const CARD_KEYBOARD_RANKS = Object.freeze(["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"]);
const CARD_KEYBOARD_SUITS = Object.freeze([
  { value: "s", label: "♠" },
  { value: "h", label: "♥" },
  { value: "d", label: "♦" },
  { value: "c", label: "♣" }
]);

const quickPicks = [
  { label: "Top Pair", token: "@tp", group: "ready" },
  { label: "Overpair", token: "@overpair", group: "ready" },
  { label: "2 Pair", token: "@2p", group: "ready" },
  { label: "Set", token: "@set", group: "ready" },
  { label: "Straight", token: "@s", group: "ready" },
  { label: "Flush", token: "@f", group: "ready" },
  { label: "Flush Draw", token: "@fd", group: "draw" },
  { label: "SD 8+ Outs", token: "@sd8", group: "draw" },
  { label: "SD 12+ Outs", token: "@sd12", group: "draw" }
];
const autocompleteEntries = [
  { token: "@2p", description: "Two-pair board-core structures." },
  { token: "@set", description: "Set/trips core structures." },
  { token: "@tp", description: "Top-pair board-core structures." },
  { token: "@overpair", description: "Pocket overpair (Hold'em)." },
  { token: "@f", description: "Flush core structures." },
  { token: "@s", description: "Straight core structures." },
  { token: "@fd", description: "Flush draw structures." },
  { token: "@sd", description: "Straight draw (1+ outs)." },
  { token: "@sd8", description: "Straight draw (8+ outs)." },
  { token: "@sd12", description: "Straight draw (12+ outs)." },
  { token: "$ds", description: "Double suited filter." },
  { token: "$ss", description: "Single suited filter." },
  { token: "$np", description: "No-pair rank structure." },
  { token: "$op", description: "One-pair rank structure." },
  { token: "$tp", description: "Two-pair rank structure." },
  { token: "15%", description: "Top 15% by selected ordering." },
  { token: "30%-50%", description: "Percentile slice." }
];
const tokenRegexCache = new Map();

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

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function standaloneTokenRegex(token, global = false) {
  const normalized = String(token || "").trim().toLowerCase();
  const key = `${normalized}|${global ? "g" : "s"}`;
  if (tokenRegexCache.has(key)) return tokenRegexCache.get(key);
  const pattern = `(^|[,:!(])${escapeRegex(normalized)}(?=$|[,:)!])`;
  const re = new RegExp(pattern, global ? "gi" : "i");
  tokenRegexCache.set(key, re);
  return re;
}

function tokenizeRangeExpressionLoose(expr) {
  const tokens = [];
  let atom = "";
  let bracketDepth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "[") {
      bracketDepth++;
      atom += ch;
      continue;
    }
    if (ch === "]") {
      atom += ch;
      if (bracketDepth > 0) bracketDepth--;
      continue;
    }
    if (bracketDepth === 0 && [",", ":", "!", "(", ")", "&"].includes(ch)) {
      if (atom) {
        tokens.push({ type: "atom", value: atom });
        atom = "";
      }
      tokens.push({ type: ch === "&" ? ":" : ch, value: ch });
      continue;
    }
    atom += ch;
  }
  if (atom) tokens.push({ type: "atom", value: atom });
  return tokens;
}

function normalizeRangeAtom(atomText) {
  const atom = String(atomText || "");
  let out = "";
  let i = 0;
  while (i < atom.length) {
    const ch = atom[i];
    if (ch === "@") {
      let j = i + 1;
      while (j < atom.length && /[a-z0-9_+]/i.test(atom[j])) j++;
      out += atom.slice(i, j).toLowerCase();
      i = j;
      continue;
    }
    if (ch === "$") {
      let j = i + 1;
      while (j < atom.length && /[a-z0-9]/i.test(atom[j])) j++;
      out += atom.slice(i, j).toLowerCase();
      i = j;
      continue;
    }
    if (/[akqjtron]/i.test(ch)) {
      out += ch.toUpperCase();
      i++;
      continue;
    }
    if (/[cdhsxyzw]/i.test(ch)) {
      out += ch.toLowerCase();
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function normalizeRangeText(rangeText) {
  const compact = String(rangeText || "").replace(/\s+/g, "");
  if (!compact || compact === "*") return "*";

  const tokens = tokenizeRangeExpressionLoose(compact);
  const out = [];
  let expectAtom = true;
  let openParens = 0;

  for (const token of tokens) {
    if (token.type === "atom") {
      const atom = normalizeRangeAtom(token.value);
      if (!atom) continue;
      if (!expectAtom) out.push(",");
      out.push(atom);
      expectAtom = false;
      continue;
    }
    if (token.type === "(") {
      if (!expectAtom) out.push(",");
      out.push("(");
      openParens++;
      expectAtom = true;
      continue;
    }
    if (token.type === ")") {
      if (expectAtom || openParens <= 0) continue;
      out.push(")");
      openParens--;
      expectAtom = false;
      continue;
    }
    if (expectAtom) continue;
    out.push(token.type);
    expectAtom = true;
  }

  while (out.length) {
    const tail = out[out.length - 1];
    if (![",", ":", "!", "("].includes(tail)) break;
    out.pop();
    if (tail === "(" && openParens > 0) openParens--;
  }
  while (out.length && [",", ":", "!"].includes(out[0])) out.shift();
  while (openParens > 0 && !expectAtom) {
    out.push(")");
    openParens--;
  }

  return out.join("") || "*";
}

function normalizeRangeTextForTyping(rangeText) {
  const compact = String(rangeText || "").replace(/\s+/g, "");
  if (!compact) return "";
  const tailMatch = compact.match(/[,:!(]+$/);
  const tail = tailMatch ? tailMatch[0] : "";
  if (!tail) return normalizeRangeText(compact);
  const coreRaw = compact.slice(0, compact.length - tail.length);
  const normalizedCore = coreRaw ? normalizeRangeText(coreRaw) : "";
  const base = normalizedCore === "*" ? "" : normalizedCore;
  return `${base}${tail}`;
}

function clampPercent(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function percentileWindowToken(fromPct, toPct) {
  const from = clampPercent(fromPct, 0, 99);
  const to = clampPercent(toPct, 1, 100);
  const hi = Math.max(from + 1, to);
  if (from <= 0) return `${hi}%`;
  return `${from}%-${hi}%`;
}

function unwrapWholeParens(text) {
  const src = String(text || "").trim();
  if (!src.startsWith("(") || !src.endsWith(")")) return src;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && i < src.length - 1) return src;
  }
  return src.slice(1, -1);
}

function splitTopLevel(text, delimiter) {
  const src = String(text || "");
  const parts = [];
  let depth = 0;
  let bracketDepth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === delimiter && depth === 0 && bracketDepth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

function parsePercentileWindowRange(rangeText) {
  const compact = String(rangeText || "").replace(/\s+/g, "");
  const pct = "(?:100(?:\\.0+)?|[0-9]{1,2}(?:\\.[0-9]+)?)";
  const topRe = new RegExp(`^(${pct})%(.*)$`);
  const sliceRe = new RegExp(`^(${pct})%-(${pct})%(.*)$`);
  const slice = compact.match(sliceRe);
  if (slice) {
    return {
      from: clampPercent(slice[1], 0, 99),
      to: clampPercent(slice[2], 1, 100),
      suffix: slice[3] || "",
      hasWindow: true
    };
  }
  const top = compact.match(topRe);
  if (top) {
    return {
      from: 0,
      to: clampPercent(top[1], 1, 100),
      suffix: top[2] || "",
      hasWindow: true
    };
  }
  const manual = normalizeRangeText(compact);
  return {
    from: 0,
    to: 30,
    suffix: manual && manual !== "*" ? `:(${manual})` : "",
    hasWindow: false
  };
}

function buildPercentileWindowRange(fromPct, toPct, suffixText) {
  const from = clampPercent(fromPct, 0, 99);
  const to = Math.max(from + 1, clampPercent(toPct, 1, 100));
  const windowToken = percentileWindowToken(from, to);
  const suffix = String(suffixText || "").trim();
  return `${windowToken}${suffix}`;
}

function normalizeScopedInnerExpression(text) {
  const normalized = normalizeRangeText(text);
  if (!normalized || normalized === "*") return "";
  return splitTopLevel(normalized, ",")
    .map((part) => unwrapWholeParens(part))
    .filter(Boolean)
    .join(",");
}

function normalizePercentileScopedRange(rangeText, allowTransient = false) {
  const compact = String(rangeText || "").replace(/\s+/g, "");
  if (!compact) return allowTransient ? "" : DEFAULT_PLAYER_RANGE;
  const parsed = parsePercentileWindowRange(compact);
  const windowToken = percentileWindowToken(parsed.from, parsed.to);
  let suffix = String(parsed.suffix || "");
  if (!suffix) return windowToken;

  const transientTail = /[,:!(]$/.test(suffix);
  if (allowTransient && transientTail) return compact;

  if (suffix.startsWith("!") && splitTopLevel(suffix, ",").length === 1) {
    return normalizeRangeText(`${windowToken}${suffix}`);
  }

  if (suffix[0] === ":" || suffix[0] === ",") suffix = suffix.slice(1);
  if (suffix.startsWith("!") || suffix.startsWith(",")) suffix = `*${suffix}`;

  const inner = normalizeScopedInnerExpression(suffix);
  if (!inner) return windowToken;
  return normalizeRangeText(`${windowToken}:(${inner})`);
}

function withSuitSymbols(rawText) {
  return String(rawText || "").replace(/([2-9TJQKA])([cdhs])/gi, (_m, rank, suit) => {
    const symbol = SUIT_SYMBOLS[String(suit || "").toLowerCase()];
    if (!symbol) return `${String(rank || "").toUpperCase()}${String(suit || "").toLowerCase()}`;
    return `${String(rank || "").toUpperCase()}${symbol}`;
  });
}

function setSuitStyledText(node, text) {
  if (!node) return;
  const src = String(text || "");
  if (!src) {
    node.textContent = "";
    return;
  }
  const fragment = document.createDocumentFragment();
  let chunk = "";
  const flushChunk = () => {
    if (!chunk) return;
    fragment.appendChild(document.createTextNode(chunk));
    chunk = "";
  };

  for (const ch of src) {
    const suitClass = SUIT_SYMBOL_CLASSES[ch];
    if (!suitClass) {
      chunk += ch;
      continue;
    }
    flushChunk();
    const span = document.createElement("span");
    span.className = `suit-symbol ${suitClass}`;
    span.textContent = ch;
    fragment.appendChild(span);
  }
  flushChunk();
  node.replaceChildren(fragment);
}

function cardsPrettyLine(rawText, label) {
  const compact = String(rawText || "").replace(/\s+/g, "");
  if (!compact) return `${label}: -`;
  let out = [];
  let i = 0;
  while (i + 1 < compact.length) {
    const rank = compact[i].toUpperCase();
    const suit = compact[i + 1].toLowerCase();
    if (!/[2-9TJQKA]/.test(rank) || !SUIT_SYMBOLS[suit]) return `${label}: ${withSuitSymbols(compact)}`;
    out.push(`${rank}${SUIT_SYMBOLS[suit]}`);
    i += 2;
  }
  if (i < compact.length) out.push(`${compact[i].toUpperCase()}_`);
  return `${label}: ${out.join(" ") || "-"}`;
}

function updateBoardPrettyPreview() {
  if (el.boardPretty) setSuitStyledText(el.boardPretty, cardsPrettyLine(el.board.value, "Board"));
}

function syncDeadVisibility() {
  const hasDead = String(el.dead?.value || "").trim().length > 0;
  const visible = uiState.deadVisible || hasDead;
  if (el.deadWrap) el.deadWrap.classList.toggle("hidden", !visible);
  if (el.deadToggle) {
    el.deadToggle.classList.toggle("is-active", visible);
    el.deadToggle.textContent = visible ? "Hide Dead" : "Dead Cards";
  }
}

function handSizeForVariant(variant) {
  const v = String(variant || "").toLowerCase();
  if (v === "holdem") return 2;
  if (v === "plo4") return 4;
  if (v === "plo5") return 5;
  return 6;
}

function normalizeSuitSymbols(text) {
  return String(text || "")
    .replace(/♣/g, "c")
    .replace(/♦/g, "d")
    .replace(/♥/g, "h")
    .replace(/♠/g, "s");
}

function parseCardsText(rawText) {
  const compact = normalizeSuitSymbols(rawText).replace(/\s+/g, "");
  if (!compact) return { cards: [], invalid: false };
  const m = compact.match(/[2-9TJQKA][cdhs]/gi);
  if (!m || m.join("").toLowerCase() !== compact.toLowerCase()) {
    return { cards: [], invalid: true };
  }
  return { cards: m.map((x) => `${x[0].toUpperCase()}${x[1].toLowerCase()}`), invalid: false };
}

function explicitCardsFromRange(rangeText) {
  const tokens = tokenizeRangeExpressionLoose(normalizeSuitSymbols(rangeText).replace(/\s+/g, ""));
  const out = [];
  for (const token of tokens) {
    if (token.type !== "atom") continue;
    const atom = normalizeSuitSymbols(String(token.value || ""));
    const runs = atom.match(/[2-9TJQKAcdhs]+/gi) || [];
    for (const run of runs) {
      if (!isExplicitCardRun(run)) continue;
      for (let i = 0; i + 1 < run.length; i += 2) {
        out.push(`${run[i].toUpperCase()}${run[i + 1].toLowerCase()}`);
      }
    }
  }
  return out;
}

function exactCardsFromRange(rangeText, variant) {
  const compact = normalizeSuitSymbols(rangeText).replace(/\s+/g, "");
  if (!compact || compact === "*") return null;
  if (/[,:!()@%$\[\]{}+\-]/.test(compact)) return null;
  const parsed = parseCardsText(compact);
  if (parsed.invalid) return null;
  if (parsed.cards.length !== handSizeForVariant(variant)) return null;
  return parsed.cards;
}

function prettyCard(cardText) {
  return withSuitSymbols(String(cardText || ""));
}

function isRankChar(ch) {
  return /[2-9TJQKA]/i.test(ch);
}

function isSuitChar(ch) {
  return /[cdhs]/i.test(ch);
}

function isExplicitCardRun(text) {
  const run = String(text || "");
  if (!run || run.length % 2 !== 0) return false;
  for (let i = 0; i < run.length; i += 2) {
    if (!isRankChar(run[i]) || !isSuitChar(run[i + 1])) return false;
  }
  return true;
}

function normalizeCardCode(rank, suit) {
  const r = String(rank || "").toUpperCase();
  const s = String(suit || "").toLowerCase();
  if (!isRankChar(r) || !isSuitChar(s)) return "";
  return `${r}${s}`;
}

function insertTextAtCursor(input, text) {
  const current = String(input?.value || "");
  const start = Number.isFinite(input?.selectionStart) ? input.selectionStart : current.length;
  const end = Number.isFinite(input?.selectionEnd) ? input.selectionEnd : start;
  const safeStart = Math.max(0, Math.min(current.length, start));
  const safeEnd = Math.max(safeStart, Math.min(current.length, end));
  const next = `${current.slice(0, safeStart)}${text}${current.slice(safeEnd)}`;
  const cursor = safeStart + String(text || "").length;
  return { value: next, cursor };
}

function appendCardToCardText(input, card, maxCards) {
  const parsed = parseCardsText(input?.value || "");
  const existing = parsed.invalid ? [] : parsed.cards;
  if (existing.includes(card)) return null;
  if (Number.isFinite(maxCards) && existing.length >= maxCards) return null;
  return insertTextAtCursor(input, card);
}

function suffixInnerText(suffix) {
  let src = String(suffix || "").trim();
  if (src[0] === ":" || src[0] === ",") src = src.slice(1);
  return unwrapWholeParens(src);
}

function appendCardToRangeInner(innerText, card, handSize) {
  const inner = String(innerText || "").trim();
  if (!inner) return card;
  const parts = splitTopLevel(inner, ",").filter((part) => part !== "");
  if (!parts.length) return card;
  const last = parts[parts.length - 1];
  const lastBare = unwrapWholeParens(last);
  if (isExplicitCardRun(lastBare) && lastBare.length < handSize * 2 && !lastBare.toLowerCase().includes(card.toLowerCase())) {
    parts[parts.length - 1] = `${lastBare}${card}`;
  } else {
    parts.push(card);
  }
  return parts.join(",");
}

function appendCardToScopedRange(rangeText, card, variant) {
  const parsed = parsePercentileWindowRange(rangeText || DEFAULT_PLAYER_RANGE);
  const inner = appendCardToRangeInner(suffixInnerText(parsed.suffix), card, handSizeForVariant(variant));
  return normalizePercentileScopedRange(`${percentileWindowToken(parsed.from, parsed.to)}:(${inner})`, true);
}

function prettyRangeDisplayText(rangeText) {
  const src = String(rangeText || "").trim();
  if (!src) return "";
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/[2-9TJQKAcdhs]/i.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[2-9TJQKAcdhs]/i.test(src[j])) j++;
      const run = src.slice(i, j);
      if (isExplicitCardRun(run)) {
        for (let k = 0; k < run.length; k += 2) {
          const rank = run[k].toUpperCase();
          const suit = run[k + 1].toLowerCase();
          out += `${rank}${SUIT_SYMBOLS[suit] || suit}`;
        }
      } else {
        out += run;
      }
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function rangeConflictMessage(playerIndex, rangeText, variant, boardText, deadText) {
  const selfFixed = explicitCardsFromRange(rangeText);
  if (!selfFixed.length) return "";

  const selfSet = new Set();
  for (const card of selfFixed) {
    if (selfSet.has(card)) return `Duplicate exact card ${prettyCard(card)} in this range.`;
    selfSet.add(card);
  }

  const board = parseCardsText(boardText);
  if (!board.invalid) {
    const boardSet = new Set(board.cards);
    for (const card of selfSet) {
      if (boardSet.has(card)) return `Exact card ${prettyCard(card)} conflicts with board.`;
    }
  }

  const dead = parseCardsText(deadText);
  if (!dead.invalid) {
    const deadSet = new Set(dead.cards);
    for (const card of selfSet) {
      if (deadSet.has(card)) return `Exact card ${prettyCard(card)} conflicts with dead cards.`;
    }
  }

  for (let i = 0; i < state.players.length; i++) {
    if (i === playerIndex) continue;
    const otherFixed = explicitCardsFromRange(state.players[i]?.range || "");
    if (!otherFixed.length) continue;
    const otherSet = new Set(otherFixed);
    for (const card of selfSet) {
      if (otherSet.has(card)) {
        return `Exact card ${prettyCard(card)} overlaps with P${i + 1} range.`;
      }
    }
  }

  return "";
}

function rangeHasStandaloneToken(rangeText, token) {
  const compact = String(rangeText || "").replace(/\s+/g, "");
  if (!compact || compact === "*") return false;
  const re = standaloneTokenRegex(token, false);
  re.lastIndex = 0;
  return re.test(compact);
}

function removeStandaloneToken(rangeText, token) {
  const compact = String(rangeText || "").replace(/\s+/g, "");
  if (!compact || compact === "*") return "*";
  const stripped = compact.replace(standaloneTokenRegex(token, true), "$1");
  return normalizeRangeText(stripped);
}

function lastNonSpaceChar(text) {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== " ") return text[i];
  }
  return "";
}

function firstNonSpaceChar(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== " ") return text[i];
  }
  return "";
}

function insertTokenAtCursor(rangeText, token, start, end) {
  const text = String(rangeText || "");
  const safeStart = Number.isFinite(start) ? Math.max(0, Math.min(text.length, start)) : text.length;
  const safeEnd = Number.isFinite(end) ? Math.max(safeStart, Math.min(text.length, end)) : safeStart;
  const left = text.slice(0, safeStart);
  const right = text.slice(safeEnd);
  const prev = lastNonSpaceChar(left);
  const next = firstNonSpaceChar(right);
  const needsBefore = !!left.trim() && !["(", ",", ":", "!"].includes(prev);
  const needsAfter = !!right.trim() && ![")", ",", ":", "!"].includes(next);
  const inserted = `${needsBefore ? "," : ""}${token}${needsAfter ? "," : ""}`;
  const value = `${left}${inserted}${right}`;
  const cursor = left.length + (needsBefore ? 1 : 0) + token.length;
  return { value, cursor };
}

function syntaxFeedback(rangeText, variant) {
  const syntax = validateRangeSyntax(rangeText, variant);
  if (syntax.ok) return { ok: true, message: "" };
  const msg = String(syntax.error || "Syntax error");
  const unexpectedLeaf = msg.match(/^Unexpected token '([^']+)' in (.+)$/);
  if (unexpectedLeaf) {
    return { ok: false, message: `Unexpected token '${unexpectedLeaf[1]}' in '${unexpectedLeaf[2]}'.` };
  }
  if (/Missing '\)'/.test(msg)) return { ok: false, message: "Missing ')' in expression." };
  if (/Expected range atom/.test(msg)) return { ok: false, message: "Expected range atom after an operator." };
  if (/Unexpected trailing expression/.test(msg)) return { ok: false, message: "Unexpected trailing expression." };
  return { ok: false, message: msg };
}

function setValidationNodeText(node, text, mode = "ok") {
  setSuitStyledText(node, String(text || ""));
  node.classList.remove("is-error", "is-ok", "is-loading");
  if (mode === "error") node.classList.add("is-error");
  else if (mode === "loading") node.classList.add("is-loading");
  else node.classList.add("is-ok");
}

function boardCardCount(boardText) {
  return Math.floor(String(boardText || "").replace(/\s+/g, "").length / 2);
}

function pruneValidationPreviewState() {
  const maxPlayers = state.players.length;
  for (const [idx, timer] of validationPreviewState.timers.entries()) {
    if (idx >= maxPlayers) {
      clearTimeout(timer);
      validationPreviewState.timers.delete(idx);
    }
  }
  for (const idx of validationPreviewState.requestSeqByPlayer.keys()) {
    if (idx >= maxPlayers) validationPreviewState.requestSeqByPlayer.delete(idx);
  }
}

function queueValidationPreview(playerIndex, node, hint, rangeText, variant, boardText, deadText, immediate = false) {
  const nextSeq = (validationPreviewState.requestSeqByPlayer.get(playerIndex) || 0) + 1;
  validationPreviewState.requestSeqByPlayer.set(playerIndex, nextSeq);

  const prevTimer = validationPreviewState.timers.get(playerIndex);
  if (prevTimer) clearTimeout(prevTimer);
  validationPreviewState.timers.delete(playerIndex);

  const feedback = syntaxFeedback(rangeText, variant);
  hint.classList.toggle("is-valid", feedback.ok);
  hint.classList.toggle("is-error", !feedback.ok);
  hint.classList.remove("is-empty");
  if (!feedback.ok) {
    setValidationNodeText(node, feedback.message, "error");
    return;
  }

  const conflict = rangeConflictMessage(playerIndex, rangeText, variant, boardText, deadText);
  if (conflict) {
    setValidationNodeText(node, conflict, "error");
    hint.classList.remove("is-valid");
    hint.classList.add("is-error");
    return;
  }

  const tags = extractNormalizedTags(rangeText).filter((t) => !!tagHintText(t));
  if (!tags.length) {
    const fallback = prettyRangeDisplayText(rangeText);
    setValidationNodeText(node, fallback || "-", "ok");
    return;
  }
  const boardLen = boardCardCount(boardText);
  if (boardLen < 3) {
    setValidationNodeText(node, "Combos need flop+ board.", "ok");
    return;
  }
  if (boardLen > 5) {
    setValidationNodeText(node, "Invalid board input.", "error");
    return;
  }

  setValidationNodeText(node, "Loading combos...", "loading");
  const delay = immediate ? 0 : 140;
  const timer = setTimeout(async () => {
    try {
      const lines = [];
      for (const tag of tags) {
        const payload = await fetchTagShortcutPayload(tag, boardText, variant);
        const lineText = shortcutTextFromPayload(payload, 18);
        lines.push(`${tag}: ${lineText}`);
      }
      if (validationPreviewState.requestSeqByPlayer.get(playerIndex) !== nextSeq) return;
      setValidationNodeText(node, lines.join(" | "), "ok");
    } catch {
      if (validationPreviewState.requestSeqByPlayer.get(playerIndex) !== nextSeq) return;
      setValidationNodeText(node, "Unable to load combos.", "error");
    } finally {
      const active = validationPreviewState.timers.get(playerIndex);
      if (active === timer) validationPreviewState.timers.delete(playerIndex);
    }
  }, delay);

  validationPreviewState.timers.set(playerIndex, timer);
}

function autocompleteMatches(fragment) {
  const part = String(fragment || "").trim().toLowerCase();
  if (!part) return [];
  if (!/^[@$%0-9]/.test(part)) return [];
  const exactPrefix = autocompleteEntries.filter((x) => x.token.toLowerCase().startsWith(part));
  if (exactPrefix.length) return exactPrefix.slice(0, 8);
  if (part === "%" || /^[0-9]+$/.test(part)) {
    return autocompleteEntries.filter((x) => x.token.includes("%")).slice(0, 4);
  }
  return autocompleteEntries.filter((x) => x.token.toLowerCase().includes(part)).slice(0, 8);
}

function cursorFragment(input) {
  const text = String(input?.value || "");
  const end = Number.isFinite(input?.selectionStart) ? input.selectionStart : text.length;
  let start = end;
  while (start > 0) {
    const ch = text[start - 1];
    if (/[,:!()\s]/.test(ch)) break;
    start--;
  }
  return {
    start,
    end,
    fragment: text.slice(start, end)
  };
}

function refreshQuickPickStates() {
  const idx = Math.max(0, Math.min(state.players.length - 1, state.focusedPlayer));
  const rangeText = String(state.players[idx]?.range || "");
  el.rangePicks.querySelectorAll("button[data-token]").forEach((button) => {
    const token = String(button.dataset.token || "").toLowerCase();
    const isActive = token ? rangeHasStandaloneToken(rangeText, token) : false;
    button.classList.toggle("is-active", isActive);
  });
}

function setFocusedPlayer(index) {
  state.focusedPlayer = Math.max(0, Math.min(state.players.length - 1, Number(index) || 0));
  refreshQuickPickStates();
}

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
  const shown = combos.slice(0, maxItems).map((c) => withSuitSymbols(c)).join(", ");
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

function initBombpotUi() {
  setBombpotStatus("Idle.");
  setBombpotProgress(0, false);
  setBombpotRunning(false);
}

function bombpotCreateProgressToken() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `bombpot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatEtaSeconds(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return "";
  if (s < 60) return `${Math.ceil(s)}s`;
  const mins = Math.floor(s / 60);
  const secs = Math.ceil(s - mins * 60);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

function setBombpotProgress(percent, visible = true) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  if (el.bombpotProgressBar) el.bombpotProgressBar.style.width = `${pct.toFixed(1)}%`;
  if (el.bombpotProgressWrap) {
    el.bombpotProgressWrap.classList.toggle("hidden", !visible);
    el.bombpotProgressWrap.setAttribute("aria-hidden", visible ? "false" : "true");
  }
}

function bombpotRuntimeCapMs(precisionConfig) {
  const baseCap = Number(precisionConfig?.iterationCap || 0);
  const scaled = Math.round(baseCap * BOMBPOT_RUNTIME_MULTIPLIER);
  return Math.max(BOMBPOT_RUNTIME_MIN_MS, Math.min(BOMBPOT_RUNTIME_MAX_MS, scaled));
}

function stopBombpotProgressPolling() {
  if (bombpotState.progressTimer) {
    clearInterval(bombpotState.progressTimer);
    bombpotState.progressTimer = null;
  }
  bombpotState.progressToken = "";
}

function updateBombpotProgressUi(progress) {
  const status = String(progress?.status || "running");
  const it = Number(progress?.iterations || 0);
  const cap = Number(progress?.iterationCap || 0);
  const minIt = Number(progress?.minIterations || 0);
  const pctCap = Number(progress?.percentOfCap || 0);
  const ips = Number(progress?.ips || 0);
  const etaCap = Number(progress?.etaCapSeconds);
  const ciNow = Number(progress?.maxHalfWidthPct);
  const ciTarget = Number(progress?.targetHalfWidthPct);

  let visualPct = 0;
  if (status === "done") {
    visualPct = 100;
  } else if (status === "error") {
    visualPct = 0;
  } else if (minIt > 0 && it < minIt) {
    visualPct = Math.min(55, (it * 55) / minIt);
  } else if (Number.isFinite(ciNow) && ciNow > 0 && Number.isFinite(ciTarget) && ciTarget > 0) {
    visualPct = 55 + Math.min(45, Math.max(0, (ciTarget / ciNow) * 45));
  } else if (cap > 0) {
    visualPct = Math.min(95, (it * 95) / cap);
  }
  setBombpotProgress(visualPct, true);

  if (!bombpotState.running) return;
  if (status === "error") {
    setBombpotStatus(`Error: ${progress?.error || "bombpot failed"}`);
    return;
  }

  const parts = [];
  parts.push(`${it.toLocaleString()} deals`);
  if (cap > 0) parts.push(`${pctCap.toFixed(1)}% of cap`);
  if (Number.isFinite(ips) && ips > 0) parts.push(`${Math.round(ips).toLocaleString()} deals/s`);
  if (Number.isFinite(etaCap) && etaCap >= 0) {
    const etaText = formatEtaSeconds(etaCap);
    if (etaText) parts.push(`up to ${etaText} left`);
  }
  if (minIt > 0 && it < minIt) {
    parts.push(`baseline ${Math.min(100, (it * 100) / minIt).toFixed(0)}%`);
  }
  if (Number.isFinite(ciNow) && ciNow > 0 && Number.isFinite(ciTarget) && ciTarget > 0) {
    parts.push(`CI95 +/-${ciNow.toFixed(2)}% (target +/-${ciTarget.toFixed(2)}%)`);
  }
  setBombpotStatus(parts.join(" | "));
}

function startBombpotProgressPolling(requestId, token) {
  stopBombpotProgressPolling();
  bombpotState.progressToken = token;
  let inFlight = false;
  const poll = async () => {
    if (inFlight) return;
    if (!bombpotState.running || requestId !== bombpotState.requestId) return;
    inFlight = true;
    try {
      const res = await fetch(`/api/sim/bombpot/progress/${encodeURIComponent(token)}`, {
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      if (!res.ok) return;
      const payload = await res.json();
      if (!payload?.ok || !payload?.progress) return;
      if (!bombpotState.running || requestId !== bombpotState.requestId) return;
      updateBombpotProgressUi(payload.progress);
    } catch {
      // keep running; next poll may recover
    } finally {
      inFlight = false;
    }
  };
  poll();
  bombpotState.progressTimer = setInterval(poll, 320);
}

async function runBombpot() {
  openBombpot();
  if (bombpotState.running) return;

  const variant = String(el.variant?.value || "").toLowerCase();
  if (!supportsBombpotVariant(variant)) {
    setBombpotProgress(0, false);
    setBombpotStatus("Bombpot supports only PLO4 and PLO5.");
    return;
  }
  const precisionPreset = normalizePrecisionPreset(el.precision?.value);
  if (el.precision) el.precision.value = precisionPreset;
  const precisionConfig = PRECISION_PRESETS[precisionPreset] || PRECISION_PRESETS[DEFAULT_PRECISION_PRESET];

  const requestId = bombpotState.requestId + 1;
  bombpotState.requestId = requestId;
  const progressToken = bombpotCreateProgressToken();
  const maxRuntimeMs = bombpotRuntimeCapMs(precisionConfig);
  setBombpotRunning(true);
  setBombpotProgress(0, true);
  setBombpotStatus("Starting bombpot...");
  startBombpotProgressPolling(requestId, progressToken);

  try {
    const res = await fetch("/api/sim/bombpot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variant,
        percentileProfile: currentOrderingProfile(variant),
        board: String(el.board?.value || "").trim(),
        dead: String(el.dead?.value || "").trim(),
        heroRange: String(state.players?.[0]?.range || "*").trim() || "*",
        iterationCap: precisionConfig.iterationCap,
        minIterations: precisionConfig.min,
        targetHalfWidthPct: precisionConfig.target,
        maxRuntimeMs,
        progressToken
      })
    });

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (requestId !== bombpotState.requestId) return;
    if (!res.ok || !payload?.ok || !payload?.result) {
      throw new Error(payload?.error || `Backend error (${res.status})`);
    }

    const result = payload.result;
    renderBombpotResultTable(result);
    const it = Number(result.iterations || 0);
    const half = Number(result.maxHalfWidthPct || 0);
    const stoppedByRuntime = !!result.stoppedByRuntime;
    const elapsedMs = Number(result.elapsedMs || 0);
    const elapsedSec = Number.isFinite(elapsedMs) ? (elapsedMs / 1000).toFixed(1) : "?";
    const runtimeCapMs = Number(result.runtimeCapMs || maxRuntimeMs || 0);
    const runtimeCapSec = Number.isFinite(runtimeCapMs) ? (runtimeCapMs / 1000).toFixed(0) : "?";
    setBombpotProgress(100, true);
    if (stoppedByRuntime) {
      setBombpotStatus(
        `${it.toLocaleString()} deals, max CI95 +/-${half.toFixed(2)}% | Runtime safeguard hit at ${elapsedSec}s (cap ${runtimeCapSec}s)`
      );
    } else {
      setBombpotStatus(`${it.toLocaleString()} deals, max CI95 +/-${half.toFixed(2)}%`);
    }
  } catch (err) {
    if (requestId !== bombpotState.requestId) return;
    setBombpotProgress(0, false);
    setBombpotStatus(`Error: ${err?.message || String(err)}`);
  } finally {
    stopBombpotProgressPolling();
    if (requestId === bombpotState.requestId) setBombpotRunning(false);
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
    deadVisible: uiState.deadVisible,
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
    uiState.deadVisible = !!s.deadVisible || String(el.dead.value || "").trim().length > 0;
    if (Array.isArray(s.players) && s.players.length >= 2) {
      state.players = s.players.slice(0, 6).map((p, i) => ({
        name: p.name || `P${i + 1}`,
        range: normalizePercentileScopedRange(p.range || DEFAULT_PLAYER_RANGE)
      }));
    }
  } catch {
    // ignore corrupt local storage
  }
  updateBoardPrettyPreview();
  syncDeadVisibility();
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
    b.dataset.token = String(p.token || "").toLowerCase();
    if (p.group) b.classList.add(`pick-${p.group}`);
    b.addEventListener("click", () => applyQuickPick(p.token));
    el.rangePicks.appendChild(b);
  }
  refreshQuickPickStates();
}

function applyQuickPick(token) {
  const idx = Math.max(0, Math.min(state.players.length - 1, state.focusedPlayer));
  const player = state.players[idx];
  if (!player) return;
  const tokenText = String(token || "").trim();
  if (!tokenText) return;

  const input = uiState.rangeInputsByPlayer.get(idx);
  const refresh = uiState.refreshByPlayer.get(idx);
  const current = String(player.range || "");

  let nextRange;
  let nextCursor = null;
  if (rangeHasStandaloneToken(current, tokenText)) {
    nextRange = removeStandaloneToken(current, tokenText);
    const prevCursor = Number.isFinite(input?.selectionStart) ? input.selectionStart : String(current).length;
    nextCursor = Math.max(0, Math.min(String(nextRange || "").length, prevCursor));
  } else if (input && document.activeElement === input) {
    const insertion = insertTokenAtCursor(current, tokenText, input.selectionStart, input.selectionEnd);
    nextRange = normalizePercentileScopedRange(insertion.value);
    nextCursor = Math.max(0, Math.min(nextRange.length, insertion.cursor));
  } else {
    const base = normalizePercentileScopedRange(current || DEFAULT_PLAYER_RANGE);
    nextRange = normalizePercentileScopedRange(base === "*" ? tokenText : `${base},${tokenText}`);
    nextCursor = nextRange.length;
  }

  nextRange = normalizePercentileScopedRange(nextRange || DEFAULT_PLAYER_RANGE);
  player.range = nextRange || DEFAULT_PLAYER_RANGE;
  if (input) {
    input.value = player.range;
    input.focus();
    const pos = Number.isFinite(nextCursor) ? nextCursor : player.range.length;
    input.setSelectionRange(pos, pos);
  }
  uiState.rangeWindowsByPlayer.get(idx)?.syncFromRangeText();
  if (refresh) refresh(true);
  else renderPlayers();
  saveLocal();
}

function openHelp() {
  closeBombpot();
  el.helpModal.classList.remove("hidden");
}

function closeHelp() {
  el.helpModal.classList.add("hidden");
}

function openBombpot() {
  closeHelp();
  if (el.bombpotModal) el.bombpotModal.classList.remove("hidden");
}

function closeBombpot() {
  if (el.bombpotModal) el.bombpotModal.classList.add("hidden");
}

function setStatus(msg) {
  el.status.textContent = msg;
}

function clearRunActivityTimer() {
  if (!runActivityState.timer) return;
  clearInterval(runActivityState.timer);
  runActivityState.timer = null;
}

function formatDuration(ms, precise = false) {
  const sec = Math.max(0, Number(ms) || 0) / 1000;
  if (sec >= 60) {
    const minutes = Math.floor(sec / 60);
    const seconds = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
  }
  return `${sec.toFixed(precise ? 2 : 1)}s`;
}

function formatRunRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${Math.round(n).toLocaleString()} it/s overall`;
}

function renderRunActivity() {
  if (!runActivityState.startedAt) return;
  const elapsedMs = performance.now() - runActivityState.startedAt;
  const parts = [runActivityState.phase || "Working"];
  const iterations = Number(runActivityState.iterations);
  if (Number.isFinite(iterations) && iterations > 0) {
    parts.push(`${Math.round(iterations).toLocaleString()} iterations`);
  }
  parts.push(`${formatDuration(elapsedMs)} total`);
  const rateText = formatRunRate(runActivityState.rate);
  if (rateText) parts.push(rateText);
  if (runActivityState.detail) parts.push(runActivityState.detail);
  setStatus(parts.join(" • "));
}

function setRunActivity({ phase, startedAt, iterations, rate, detail, live = true }) {
  if (startedAt) runActivityState.startedAt = startedAt;
  if (!runActivityState.startedAt) runActivityState.startedAt = performance.now();
  if (phase !== undefined) runActivityState.phase = String(phase || "Working");
  if (iterations !== undefined) runActivityState.iterations = Number(iterations) || 0;
  if (rate !== undefined) runActivityState.rate = Number(rate);
  if (detail !== undefined) runActivityState.detail = String(detail || "");
  renderRunActivity();
  if (live && !runActivityState.timer) {
    runActivityState.timer = setInterval(renderRunActivity, 250);
  }
}

function setFinalRunStatus(text) {
  clearRunActivityTimer();
  runActivityState.startedAt = 0;
  runActivityState.phase = "";
  runActivityState.iterations = 0;
  runActivityState.rate = NaN;
  runActivityState.detail = "";
  setStatus(text);
}

function usedCardCodes() {
  const out = new Set();
  for (const source of [el.board?.value, el.dead?.value]) {
    const parsed = parseCardsText(source || "");
    if (!parsed.invalid) parsed.cards.forEach((card) => out.add(card));
  }
  state.players.forEach((player) => {
    explicitCardsFromRange(player?.range || "").forEach((card) => out.add(card));
  });
  return out;
}

function targetCardCount(target) {
  if (!target?.input) return 0;
  if (target.kind === "board" || target.kind === "dead") {
    const parsed = parseCardsText(target.input.value || "");
    return parsed.invalid ? 0 : parsed.cards.length;
  }
  return explicitCardsFromRange(target.input.value || "").length;
}

function renderCardKeyboard() {
  if (!el.cardKeyboardSuits || !el.cardKeyboardRanks) return;
  const target = cardKeyboardState.target;
  const used = usedCardCodes();
  const maxReached = (target?.kind === "board" || target?.kind === "dead") && targetCardCount(target) >= 5;

  el.cardKeyboardTarget.textContent = target?.label ? ` ${target.label}` : "";
  el.cardKeyboardSuits.innerHTML = "";
  for (const suit of CARD_KEYBOARD_SUITS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = suit.label;
    button.className = `card-keyboard-suit suit-key-${suit.value}`;
    button.classList.toggle("is-active", cardKeyboardState.suit === suit.value);
    button.addEventListener("click", () => {
      cardKeyboardState.suit = suit.value;
      renderCardKeyboard();
    });
    el.cardKeyboardSuits.appendChild(button);
  }

  el.cardKeyboardRanks.innerHTML = "";
  for (const rank of CARD_KEYBOARD_RANKS) {
    const card = normalizeCardCode(rank, cardKeyboardState.suit);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = rank;
    button.className = `card-keyboard-rank suit-key-${cardKeyboardState.suit}`;
    button.disabled = !target || maxReached || used.has(card);
    button.addEventListener("click", () => insertCardFromKeyboard(card));
    el.cardKeyboardRanks.appendChild(button);
  }
}

function positionCardKeyboard(trigger) {
  if (!el.cardKeyboardPanel || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  const width = 286;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
  const top = Math.min(window.innerHeight - 190, rect.bottom + 6);
  el.cardKeyboardPanel.style.left = `${left}px`;
  el.cardKeyboardPanel.style.top = `${Math.max(8, top)}px`;
}

function openCardKeyboard(target, trigger) {
  if (!el.cardKeyboard || !target?.input) return;
  cardKeyboardState.target = { ...target, trigger };
  document.querySelectorAll(".card-keyboard-trigger[aria-expanded='true']").forEach((node) => {
    node.setAttribute("aria-expanded", "false");
  });
  trigger?.setAttribute("aria-expanded", "true");
  el.cardKeyboard.classList.remove("hidden");
  positionCardKeyboard(trigger);
  renderCardKeyboard();
}

function closeCardKeyboard() {
  if (!el.cardKeyboard) return;
  el.cardKeyboard.classList.add("hidden");
  cardKeyboardState.target?.trigger?.setAttribute("aria-expanded", "false");
  cardKeyboardState.target = null;
}

function insertCardFromKeyboard(card) {
  const target = cardKeyboardState.target;
  if (!target?.input || !card) return;

  if (target.kind === "board" || target.kind === "dead") {
    const inserted = appendCardToCardText(target.input, card, 5);
    if (!inserted) return;
    target.input.value = inserted.value;
    target.input.focus();
    target.input.setSelectionRange(inserted.cursor, inserted.cursor);
    target.onChange?.();
  } else if (target.kind === "range") {
    const next = appendCardToScopedRange(target.input.value || target.player?.range || DEFAULT_PLAYER_RANGE, card, el.variant.value);
    target.input.value = next;
    target.input.focus();
    target.input.setSelectionRange(next.length, next.length);
    if (target.player) target.player.range = next;
    target.rangeWindow?.syncFromRangeText();
    saveLocal();
    target.refresh?.(false);
  }

  renderCardKeyboard();
}

function initCardKeyboard() {
  renderCardKeyboard();
  el.cardKeyboardClose?.addEventListener("click", closeCardKeyboard);
  el.cardKeyboard?.addEventListener("click", (event) => {
    if (event.target === el.cardKeyboard) closeCardKeyboard();
  });
  window.addEventListener("resize", () => {
    if (el.cardKeyboard?.classList.contains("hidden")) return;
    positionCardKeyboard(cardKeyboardState.target?.trigger);
  });
}

function supportsBombpotVariant(variant) {
  const v = String(variant || "").toLowerCase();
  return v === "plo4" || v === "plo5";
}

function setBombpotStatus(text) {
  if (!el.bombpotStatus) return;
  el.bombpotStatus.textContent = String(text || "");
}

function setBombpotMeta(text) {
  if (!el.bombpotMeta) return;
  setSuitStyledText(el.bombpotMeta, String(text || ""));
}

function clearBombpotResultTable() {
  if (!el.bombpotResult) return;
  el.bombpotResult.innerHTML = "";
}

function formatBombpotPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(2)}%`;
}

function setBombpotRunning(running) {
  bombpotState.running = !!running;
  if (el.bombpotRun) el.bombpotRun.disabled = bombpotState.running;
}

function renderBombpotResultTable(payload) {
  if (!el.bombpotResult) return;
  clearBombpotResultTable();

  const categories = Array.isArray(payload?.categories) ? payload.categories : [];
  const rows = Array.isArray(payload?.tableRows) ? payload.tableRows : [];
  if (!categories.length || !rows.length) {
    setBombpotStatus("Bombpot returned no data.");
    return;
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const playersHead = document.createElement("th");
  playersHead.textContent = "Players";
  headRow.appendChild(playersHead);
  for (const cat of categories) {
    const th = document.createElement("th");
    th.textContent = cat?.label || cat?.id || "?";
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const tdPlayers = document.createElement("td");
    tdPlayers.textContent = `${Number(row?.players) || 0}p`;
    tr.appendChild(tdPlayers);

    const values = Array.isArray(row?.values) ? row.values : [];
    for (let i = 0; i < categories.length; i++) {
      const td = document.createElement("td");
      td.textContent = formatBombpotPercent(values[i]);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  el.bombpotResult.appendChild(table);

  const boardText = String(payload?.boardText || "").trim();
  const deadText = String(payload?.deadText || "").trim();
  const heroRange = String(payload?.heroRange || "*").trim() || "*";
  const boardShown = boardText ? withSuitSymbols(boardText) : "-";
  const deadShown = deadText ? withSuitSymbols(deadText) : "-";
  setBombpotMeta(`P1 range: ${heroRange} | Board: ${boardShown} | Dead: ${deadShown}`);
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

function createRangeWindowSlider(player, playerIndex, rangeInput, refreshDerived, closeAutocomplete) {
  const wrap = document.createElement("div");
  wrap.className = "range-window-slider";

  const track = document.createElement("div");
  track.className = "range-window-track";
  const fill = document.createElement("div");
  fill.className = "range-window-fill";
  const startThumb = document.createElement("button");
  const endThumb = document.createElement("button");
  const thumbs = [
    { node: startThumb, key: "start", label: "Range start" },
    { node: endThumb, key: "end", label: "Range end" }
  ];

  let start = 0;
  let end = 30;
  let dragging = "";

  for (const thumb of thumbs) {
    thumb.node.type = "button";
    thumb.node.className = `range-window-thumb range-window-${thumb.key}`;
    thumb.node.dataset.thumb = thumb.key;
    thumb.node.setAttribute("role", "slider");
    thumb.node.setAttribute("aria-label", thumb.label);
    thumb.node.setAttribute("aria-valuemin", thumb.key === "start" ? "0" : "1");
    thumb.node.setAttribute("aria-valuemax", thumb.key === "start" ? "99" : "100");
  }

  function syncFromRangeText() {
    const parsed = parsePercentileWindowRange(rangeInput.value || player.range);
    start = clampPercent(parsed.from, 0, 99);
    end = Math.max(start + 1, clampPercent(parsed.to, 1, 100));
    paint();
  }

  function paint() {
    start = clampPercent(start, 0, 99);
    end = Math.max(start + 1, clampPercent(end, 1, 100));
    const left = `${start}%`;
    const right = `${100 - end}%`;
    fill.style.left = left;
    fill.style.right = right;
    startThumb.style.left = left;
    endThumb.style.left = `${end}%`;
    startThumb.setAttribute("aria-valuenow", String(start));
    endThumb.setAttribute("aria-valuenow", String(end));
    startThumb.setAttribute("aria-valuetext", `Skip top ${start}%`);
    endThumb.setAttribute("aria-valuetext", `Play to ${end}%`);
    wrap.title = start > 0 ? `${start}%-${end}%` : `${end}%`;
  }

  function commit() {
    const parsed = parsePercentileWindowRange(rangeInput.value || player.range);
    const nextRange = normalizePercentileScopedRange(buildPercentileWindowRange(start, end, parsed.suffix));
    player.range = nextRange;
    rangeInput.value = nextRange;
    closeAutocomplete();
    saveLocal();
    refreshDerived(false);
    paint();
  }

  function pctFromEvent(event) {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return start;
    const pct = ((event.clientX - rect.left) / rect.width) * 100;
    return clampPercent(pct, 0, 100);
  }

  function moveThumb(which, pct) {
    if (which === "start") start = Math.min(clampPercent(pct, 0, 99), end - 1);
    else end = Math.max(clampPercent(pct, 1, 100), start + 1);
    commit();
  }

  wrap.addEventListener("pointerdown", (event) => {
    setFocusedPlayer(playerIndex);
    const pct = pctFromEvent(event);
    dragging = event.target?.dataset?.thumb || (Math.abs(pct - start) <= Math.abs(pct - end) ? "start" : "end");
    wrap.setPointerCapture?.(event.pointerId);
    moveThumb(dragging, pct);
  });
  wrap.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    moveThumb(dragging, pctFromEvent(event));
  });
  wrap.addEventListener("pointerup", () => {
    dragging = "";
  });
  wrap.addEventListener("pointercancel", () => {
    dragging = "";
  });

  for (const thumb of thumbs) {
    thumb.node.addEventListener("focus", () => setFocusedPlayer(playerIndex));
    thumb.node.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 5 : 1;
      if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      const delta = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -step : step;
      moveThumb(thumb.key, (thumb.key === "start" ? start : end) + delta);
    });
  }

  track.appendChild(fill);
  track.appendChild(startThumb);
  track.appendChild(endThumb);
  wrap.appendChild(track);
  syncFromRangeText();
  return { node: wrap, syncFromRangeText };
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
  if (cardKeyboardState.target?.kind === "range") closeCardKeyboard();
  el.players.innerHTML = "";
  liveInfoState.nodeByPlayer.clear();
  uiState.rangeInputsByPlayer.clear();
  uiState.rangeWindowsByPlayer.clear();
  uiState.refreshByPlayer.clear();
  for (const timer of validationPreviewState.timers.values()) clearTimeout(timer);
  validationPreviewState.timers.clear();
  validationPreviewState.requestSeqByPlayer.clear();
  if (state.focusedPlayer >= state.players.length) state.focusedPlayer = Math.max(0, state.players.length - 1);
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
    range.placeholder = "Range syntax, e.g. 5%-30%:(AA,$ds,@fd)";
    range.addEventListener("focus", () => {
      setFocusedPlayer(i);
    });
    uiState.rangeInputsByPlayer.set(i, range);

    main.appendChild(tag);
    main.appendChild(range);

    const cardButton = document.createElement("button");
    cardButton.type = "button";
    cardButton.className = "card-keyboard-trigger";
    cardButton.textContent = "A♠";
    cardButton.setAttribute("aria-label", `Open P${i + 1} card keyboard`);

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
      setSuitStyledText(pop, "Loading tag structures...");
      pop.addEventListener("click", (e) => e.stopPropagation());
      row.appendChild(pop);
      hint.setAttribute("aria-expanded", "true");
      (async () => {
        try {
          const out = await rangeTagHintsWithShortcuts(p.range, el.variant.value, el.board.value.trim());
          await copyTextToClipboard(out.comboText);
          if (!row.contains(pop)) return;
          setSuitStyledText(pop, out.text || "No @tag used in this range.");
        } catch {
          if (!row.contains(pop)) return;
          setSuitStyledText(pop, rangeTagHints(p.range, el.variant.value) || "No @tag used in this range.");
        }
      })();
    });
    main.appendChild(cardButton);
    main.appendChild(hint);
    row.appendChild(main);

    const auto = document.createElement("div");
    auto.className = "range-autocomplete hidden";
    row.appendChild(auto);

    const validation = document.createElement("div");
    validation.className = "player-validation";
    row.appendChild(validation);

    const info = document.createElement("div");
    info.className = "player-live-note";
    row.appendChild(info);
    liveInfoState.nodeByPlayer.set(i, info);

    let autoItems = [];
    let autoActive = 0;
    let activeFragment = { start: 0, end: 0, fragment: "" };

    const closeAutocomplete = () => {
      autoItems = [];
      autoActive = 0;
      auto.classList.add("hidden");
      auto.innerHTML = "";
    };

    const paintAutocomplete = () => {
      if (!autoItems.length) {
        closeAutocomplete();
        return;
      }
      auto.innerHTML = "";
      autoItems.forEach((entry, idx) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "range-autocomplete-item";
        if (idx === autoActive) button.classList.add("is-active");

        const tokenNode = document.createElement("span");
        tokenNode.className = "auto-token";
        tokenNode.textContent = entry.token;
        const descNode = document.createElement("span");
        descNode.className = "auto-desc";
        descNode.textContent = entry.description;

        button.appendChild(tokenNode);
        button.appendChild(descNode);
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          autoActive = idx;
          const before = range.value.slice(0, activeFragment.start);
          const after = range.value.slice(activeFragment.end);
          const next = `${before}${entry.token}${after}`;
          p.range = normalizePercentileScopedRange(next);
          range.value = p.range;
          const cursorPos = Math.max(0, Math.min(p.range.length, before.length + entry.token.length));
          range.focus();
          range.setSelectionRange(cursorPos, cursorPos);
          closeAutocomplete();
          saveLocal();
          rangeWindow.syncFromRangeText();
          refreshDerived(false);
        });
        auto.appendChild(button);
      });
      auto.classList.remove("hidden");
    };

    const refreshAutocomplete = () => {
      activeFragment = cursorFragment(range);
      const matches = autocompleteMatches(activeFragment.fragment);
      if (!matches.length) {
        closeAutocomplete();
        return;
      }
      autoItems = matches;
      if (autoActive >= autoItems.length) autoActive = 0;
      paintAutocomplete();
    };

    const refreshDerived = (immediate = false) => {
      queueValidationPreview(i, validation, hint, p.range, el.variant.value, el.board.value.trim(), el.dead.value.trim(), immediate);
      queueLiveInfoUpdate(i, p.range, immediate);
      refreshQuickPickStates();
    };
    uiState.refreshByPlayer.set(i, refreshDerived);

    const rangeWindow = createRangeWindowSlider(p, i, range, refreshDerived, closeAutocomplete);
    uiState.rangeWindowsByPlayer.set(i, rangeWindow);
    row.insertBefore(rangeWindow.node, validation);
    cardButton.addEventListener("click", () => {
      setFocusedPlayer(i);
      openCardKeyboard({
        kind: "range",
        label: `P${i + 1}`,
        input: range,
        player: p,
        refresh: refreshDerived,
        rangeWindow
      }, cardButton);
    });

    range.addEventListener("input", (event) => {
      let nextValue = range.value;
      const inserted = typeof event?.data === "string" ? event.data : "";
      const isDelimiterTyped = inserted.includes(",") || inserted.includes(" ");
      if (isDelimiterTyped) {
        const cursorAtEnd = Number.isFinite(range.selectionStart)
          && Number.isFinite(range.selectionEnd)
          && range.selectionStart === range.selectionEnd
          && range.selectionEnd === nextValue.length;
        if (cursorAtEnd) {
          const normalizedTyping = normalizeRangeTextForTyping(nextValue);
          if (normalizedTyping !== nextValue) {
            nextValue = normalizedTyping;
            range.value = nextValue;
            range.setSelectionRange(nextValue.length, nextValue.length);
          }
        } else if (inserted.includes(" ")) {
          const compact = nextValue.replace(/\s+/g, "");
          if (compact !== nextValue) {
            nextValue = compact;
            range.value = nextValue;
          }
        }
      }
      const scopedValue = normalizePercentileScopedRange(nextValue, true);
      if (scopedValue !== nextValue && validateRangeSyntax(scopedValue, el.variant.value).ok) {
        nextValue = scopedValue;
        range.value = nextValue;
        range.setSelectionRange(nextValue.length, nextValue.length);
      }
      p.range = nextValue;
      saveLocal();
      refreshDerived(false);
      rangeWindow.syncFromRangeText();
      refreshAutocomplete();
    });
    range.addEventListener("click", refreshAutocomplete);
    range.addEventListener("keyup", (event) => {
      if (["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) return;
      refreshAutocomplete();
    });
    range.addEventListener("keydown", (event) => {
      const isOpen = !auto.classList.contains("hidden") && autoItems.length > 0;
      if (!isOpen) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        autoActive = (autoActive + 1) % autoItems.length;
        paintAutocomplete();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        autoActive = (autoActive - 1 + autoItems.length) % autoItems.length;
        paintAutocomplete();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const before = range.value.slice(0, activeFragment.start);
        const after = range.value.slice(activeFragment.end);
        const chosen = autoItems[autoActive];
        const next = `${before}${chosen.token}${after}`;
        p.range = normalizePercentileScopedRange(next);
        range.value = p.range;
        const cursorPos = Math.max(0, Math.min(p.range.length, before.length + chosen.token.length));
        range.setSelectionRange(cursorPos, cursorPos);
        closeAutocomplete();
        saveLocal();
        rangeWindow.syncFromRangeText();
        refreshDerived(false);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeAutocomplete();
      }
    });
    range.addEventListener("blur", () => {
      setTimeout(() => closeAutocomplete(), 120);
      const normalizedFinal = normalizePercentileScopedRange(range.value);
      if (normalizedFinal === range.value) return;
      p.range = normalizedFinal;
      range.value = normalizedFinal;
      saveLocal();
      rangeWindow.syncFromRangeText();
      refreshDerived(true);
    });
    refreshDerived(false);
    row.appendChild(playerOutputRow(results[i], i, results));
    el.players.appendChild(row);
  });
  pruneLiveInfoState();
  pruneValidationPreviewState();
  refreshQuickPickStates();
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
      range: normalizePercentileScopedRange(p.range?.trim() || DEFAULT_PLAYER_RANGE)
    }))
  };
}

async function run() {
  if (state.isRunning) return;
  state.isRunning = true;
  el.run.disabled = true;
  if (el.stop) el.stop.disabled = false;
  runAbortController = new AbortController();
  const endToEndStarted = performance.now();

  try {
    const config = currentConfig();
    const controller = runAbortController;
    setRunActivity({ phase: "Preparing coverage", startedAt: endToEndStarted });
    const coverageStarted = performance.now();
    config.rangeCoverage = await collectRangeCoverageSnapshot(config, controller?.signal);
    const coverageMs = performance.now() - coverageStarted;
    if (!controller || controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    setRunActivity({ phase: "Running simulation", detail: "waiting for iterations" });
    const result = await runSimulation(config, (p) => {
      const iterations = Number(p.iterations);
      if (Number.isFinite(iterations) && iterations > 0) {
        const totalElapsedSec = Math.max(0.001, (performance.now() - endToEndStarted) / 1000);
        setRunActivity({
          phase: "Running simulation",
          iterations,
          rate: iterations / totalElapsedSec,
          detail: ""
        });
      } else {
        setRunActivity({ phase: "Running simulation", detail: "preparing/evaluating ranges" });
      }
    }, controller.signal);
    result.timings = result.timings || {};
    result.timings.coverageMs = coverageMs;
    const endToEndMs = performance.now() - endToEndStarted;
    result.timings.endToEndMs = endToEndMs;
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
    renderPlayers();
    const avgIps = result.iterations / Math.max(0.001, endToEndMs / 1000);
    const totalText = formatDuration(endToEndMs, true);
    const ipsText = formatRunRate(avgIps);
    if (result.aborted || controller.signal.aborted) {
      setFinalRunStatus(`Stopped • ${result.iterations.toLocaleString()} iterations • ${totalText} total • ${ipsText}`);
    } else {
      setFinalRunStatus(`Done • ${result.iterations.toLocaleString()} iterations • ${totalText} total • ${ipsText}`);
    }
  } catch (err) {
    if (runAbortController?.signal?.aborted || err?.name === "AbortError") setFinalRunStatus("Stopped.");
    else setFinalRunStatus(`Error: ${err.message || String(err)}`);
  } finally {
    state.isRunning = false;
    runAbortController = null;
    el.run.disabled = false;
    if (el.stop) el.stop.disabled = true;
  }
}

function stopRun() {
  if (!state.isRunning || !runAbortController) return;
  runAbortController.abort();
  setRunActivity({ phase: "Stopping", detail: "" });
}

function clearAllFields() {
  if (state.isRunning) return;
  el.board.value = "";
  el.dead.value = "";
  uiState.deadVisible = false;
  syncDeadVisibility();
  state.lastResult = null;
  state.players = state.players.map((p, i) => ({
    name: p.name || `P${i + 1}`,
    range: DEFAULT_PLAYER_RANGE
  }));
  renderPlayers();
  updateBoardPrettyPreview();
  clearBombpotResultTable();
  setBombpotMeta("");
  setBombpotProgress(0, false);
  if (!bombpotState.running) setBombpotStatus("Idle.");
  saveLocal();
  setStatus("Cleared board, dead cards, ranges, and results.");
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
      uiState.deadVisible = String(el.dead.value || "").trim().length > 0;
      syncDeadVisibility();
      updateBoardPrettyPreview();
      state.players = setup.players.slice(0, 6).map((p, i) => ({
        name: p.name || `P${i + 1}`,
        range: normalizePercentileScopedRange(p.range || DEFAULT_PLAYER_RANGE)
      }));

      state.lastResult = payload.result || null;
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
  document.addEventListener("click", (event) => {
    document.querySelectorAll(".tag-hint-popover").forEach((n) => n.remove());
    document.querySelectorAll(".tag-hint[aria-expanded='true']").forEach((n) => n.setAttribute("aria-expanded", "false"));
    const target = event.target;
    const keepAutocomplete = !!(target instanceof Element && target.closest(".player-range-input, .range-autocomplete"));
    if (keepAutocomplete) return;
    document.querySelectorAll(".range-autocomplete").forEach((n) => n.classList.add("hidden"));
  });

  el.addPlayer.addEventListener("click", () => {
    if (state.isRunning) return;
    if (state.players.length >= 6) {
      setStatus("Max 6 players.");
      return;
    }
    state.players.push({ name: `P${state.players.length + 1}`, range: DEFAULT_PLAYER_RANGE });
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
  if (el.stop) el.stop.addEventListener("click", stopRun);
  if (el.bombpotRun) el.bombpotRun.addEventListener("click", runBombpot);
  if (el.clearAll) el.clearAll.addEventListener("click", clearAllFields);
  el.helpOpen.addEventListener("click", openHelp);
  el.helpClose.addEventListener("click", closeHelp);
  if (el.bombpotClose) el.bombpotClose.addEventListener("click", closeBombpot);
  el.helpModal.addEventListener("click", (event) => {
    if (event.target === el.helpModal) closeHelp();
  });
  if (el.bombpotModal) {
    el.bombpotModal.addEventListener("click", (event) => {
      if (event.target === el.bombpotModal) closeBombpot();
    });
  }
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (el.cardKeyboard && !el.cardKeyboard.classList.contains("hidden")) {
      closeCardKeyboard();
      return;
    }
    if (el.helpModal && !el.helpModal.classList.contains("hidden")) {
      closeHelp();
      return;
    }
    if (el.bombpotModal && !el.bombpotModal.classList.contains("hidden")) closeBombpot();
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
  el.board.addEventListener("input", updateBoardPrettyPreview);
  el.variant.addEventListener("change", () => {
    syncOrderingProfileControl();
    saveLocal();
    renderPlayers();
    setBombpotRunning(bombpotState.running);
    if (!supportsBombpotVariant(el.variant.value) && !bombpotState.running) {
      setBombpotProgress(0, false);
      setBombpotStatus("Bombpot supports only PLO4 and PLO5.");
    } else if (!bombpotState.running) {
      setBombpotProgress(0, false);
      setBombpotStatus("Idle.");
    }
  });
  if (el.orderingProfile) {
    el.orderingProfile.addEventListener("change", () => {
      syncOrderingProfileControl();
      saveLocal();
      renderPlayers();
    });
  }
  el.board.addEventListener("input", () => {
    renderCardKeyboard();
    renderPlayers();
  });
  el.dead.addEventListener("input", () => {
    if (!String(el.dead.value || "").trim()) uiState.deadVisible = false;
    syncDeadVisibility();
    renderCardKeyboard();
    renderPlayers();
  });
  el.boardCardKeyboard?.addEventListener("click", () => {
    openCardKeyboard({
      kind: "board",
      label: "Board",
      input: el.board,
      onChange: () => {
        updateBoardPrettyPreview();
        saveLocal();
        renderPlayers();
      }
    }, el.boardCardKeyboard);
  });
  el.deadCardKeyboard?.addEventListener("click", () => {
    uiState.deadVisible = true;
    syncDeadVisibility();
    openCardKeyboard({
      kind: "dead",
      label: "Dead",
      input: el.dead,
      onChange: () => {
        uiState.deadVisible = true;
        syncDeadVisibility();
        saveLocal();
        renderPlayers();
      }
    }, el.deadCardKeyboard);
  });
  if (el.deadToggle) {
    el.deadToggle.addEventListener("click", () => {
      uiState.deadVisible = !uiState.deadVisible;
      syncDeadVisibility();
      saveLocal();
    });
  }

}

loadLocal();
syncOrderingProfileControl();
updateBoardPrettyPreview();
initLiveInfoWorker();
initBombpotUi();
initCardKeyboard();
renderQuickPicks();
renderPlayers();
wire();
window.addEventListener("beforeunload", () => {
  if (liveInfoState.worker) liveInfoState.worker.terminate();
});
if (el.stop) el.stop.disabled = true;
setBombpotMeta("Uses P1 range as hero filter. Opponents are always 100% random.");
if (!supportsBombpotVariant(el.variant.value)) setBombpotStatus("Bombpot supports only PLO4 and PLO5.");
setBombpotRunning(false);
setStatus("Idle.");
