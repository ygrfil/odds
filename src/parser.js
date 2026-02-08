import { RANKS, SUITS, rankOf, suitOf } from "./cards.js";

const RANK_ORDER = [...RANKS];
const ALL_RANKS = new Set(RANK_ORDER);
const ALL_SUITS = new Set([...SUITS]);

const MACRO_REPLACEMENTS = {
  "$s": ":xx",
  "$o": ":xy",
  "$ds": ":xxyy",
  "$ss": ":xxyz",
  "$np": "!RR",
  "$op": ":RRON",
  "$tp": ":RROO",
  "$nt": "!RRR",
  "$B": "[A-J]",
  "$M": "[T-7]",
  "$Z": "[6-2]",
  "$L": "[A,2,3,4,5,6,7,8]",
  "$N": "[K-9]",
  "$F": "[K-J]",
  "$R": "[A-T]",
  "$W": "[A,2,3,4,5]",
  "$0g": "AKQJ-",
  "$1g": "(AKQT-,AKJT-,AQJT-)",
  "$2g": "(AKQ9-,AKT9-,AJT9-)"
};

const RANK_VARS = new Set(["R", "O", "N"]);
const SUIT_VARS = new Set(["x", "y", "z", "w"]);
const CATEGORY_TAGS = new Set(["@set", "@2p", "@fd", "@sd", "@sd4", "@sd8", "@sd12", "@sd13", "@flush", "@straight", "@tpplus", "@overpair"]);

const percentileCache = new Map();

function stripSpaces(s) {
  return s.replace(/\s+/g, "").replaceAll("&", ":");
}

function tokenizeExpr(s) {
  const out = [];
  let cur = "";
  let b = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "[") b++;
    if (ch === "]") b--;
    if (b === 0 && [",", ":", "!", "(", ")", "&"].includes(ch)) {
      if (cur) {
        out.push({ type: "atom", value: cur });
        cur = "";
      }
      out.push({ type: ch === "&" ? ":" : ch, value: ch });
    } else {
      cur += ch;
    }
  }
  if (cur) out.push({ type: "atom", value: cur });
  return out;
}

function parser(tokens) {
  let pos = 0;
  function peek() {
    return tokens[pos];
  }
  function take(type) {
    const t = tokens[pos];
    if (!t || t.type !== type) return null;
    pos++;
    return t;
  }
  function parsePrimary() {
    if (take("(")) {
      const e = parseUnion();
      if (!take(")")) throw new Error("Missing ')' in expression");
      return e;
    }
    const t = take("atom");
    if (!t) throw new Error("Expected range atom");
    return { kind: "atom", value: t.value };
  }
  function parseConstraint() {
    let left = parsePrimary();
    while (peek() && (peek().type === ":" || peek().type === "!")) {
      const op = tokens[pos++].type;
      const right = parsePrimary();
      left = { kind: op === ":" ? "and" : "not", left, right };
    }
    return left;
  }
  function parseUnion() {
    let left = parseConstraint();
    while (peek() && peek().type === ",") {
      pos++;
      const right = parseConstraint();
      left = { kind: "or", left, right };
    }
    return left;
  }
  const ast = parseUnion();
  if (pos !== tokens.length) throw new Error("Unexpected trailing expression");
  return ast;
}

function rankSetFromExpr(expr) {
  const e = expr.toUpperCase();
  if (e.length === 1 && ALL_RANKS.has(e)) return new Set([e]);
  if (e.length === 1 && RANK_VARS.has(e)) return new Set(RANK_ORDER);
  if (e.includes("-")) {
    const [a, b] = e.split("-");
    if (a.length === 1 && b.length === 1 && ALL_RANKS.has(a) && ALL_RANKS.has(b)) {
      const ia = RANK_ORDER.indexOf(a);
      const ib = RANK_ORDER.indexOf(b);
      const lo = Math.min(ia, ib);
      const hi = Math.max(ia, ib);
      return new Set(RANK_ORDER.slice(lo, hi + 1));
    }
  }
  if (e.startsWith("[") && e.endsWith("]")) {
    const inside = e.slice(1, -1);
    const parts = inside.split(",").map((x) => x.trim()).filter(Boolean);
    const set = new Set();
    for (const p of parts) {
      if (p.includes("-")) {
        for (const r of rankSetFromExpr(p)) set.add(r);
      } else if (ALL_RANKS.has(p)) {
        set.add(p);
      }
    }
    if (set.size) return set;
  }
  return null;
}

function suitFromToken(t) {
  if (!t) return null;
  if (ALL_SUITS.has(t)) return { type: "fixed", value: t };
  if (SUIT_VARS.has(t)) return { type: "var", value: t };
  return null;
}

function parseLeafSpecs(leaf) {
  const specs = [];
  const noPairGroups = [];
  let i = 0;
  while (i < leaf.length) {
    const ch = leaf[i];
    if (ch === "{") {
      const end = leaf.indexOf("}", i);
      if (end < 0) throw new Error("Missing '}'");
      const inner = parseLeafSpecs(leaf.slice(i + 1, end));
      noPairGroups.push(inner.specs.length);
      specs.push(...inner.specs.map((x) => ({ ...x, np: true })));
      i = end + 1;
      continue;
    }
    if (ch === "*") {
      let suit = null;
      const sn = suitFromToken(leaf[i + 1]);
      if (sn) {
        suit = sn;
        i++;
      }
      specs.push({ ranks: new Set(RANK_ORDER), rankVar: null, suit });
      i++;
      continue;
    }
    if (ch === "[") {
      const end = leaf.indexOf("]", i);
      if (end < 0) throw new Error("Missing ']' in rank list");
      const rs = rankSetFromExpr(leaf.slice(i, end + 1));
      if (!rs) throw new Error(`Invalid rank list: ${leaf.slice(i, end + 1)}`);
      let suit = null;
      const sn = suitFromToken(leaf[end + 1]);
      if (sn) {
        suit = sn;
        i = end + 2;
      } else {
        i = end + 1;
      }
      specs.push({ ranks: rs, rankVar: null, suit });
      continue;
    }

    const up = ch.toUpperCase();
    if (ALL_RANKS.has(up) || RANK_VARS.has(up)) {
      let ranks = ALL_RANKS.has(up) ? new Set([up]) : new Set(RANK_ORDER);
      let rankVar = RANK_VARS.has(up) ? up : null;
      if (ALL_RANKS.has(up) && (leaf[i + 1] === "+" || leaf[i + 1] === "-")) {
        const idx = RANK_ORDER.indexOf(up);
        ranks = leaf[i + 1] === "+"
          ? new Set(RANK_ORDER.slice(idx))
          : new Set(RANK_ORDER.slice(0, idx + 1));
        i++;
      }
      let suit = null;
      const sn = suitFromToken(leaf[i + 1]);
      if (sn) {
        suit = sn;
        i++;
      }
      specs.push({ ranks, rankVar, suit });
      i++;
      continue;
    }

    const sn = suitFromToken(ch);
    if (sn) {
      specs.push({ ranks: new Set(RANK_ORDER), rankVar: null, suit: sn });
      i++;
      continue;
    }

    throw new Error(`Unexpected token '${ch}' in ${leaf}`);
  }
  return { specs, noPairGroups };
}

function expandExprMacros(expr) {
  let s = expr;
  for (const [k, v] of Object.entries(MACRO_REPLACEMENTS)) {
    s = s.split(k).join(v);
  }
  return s;
}

function expandShortcuts(atom, variant) {
  let s = atom;
  if (variant === "holdem") {
    s = s.replace(/([2-9TJQKA])([2-9TJQKA])s\b/gi, "$1x$2x");
    s = s.replace(/([2-9TJQKA])([2-9TJQKA])o\b/gi, "$1x$2y");
  }

  return s;
}

function expandSpan(atom) {
  const s = atom.toUpperCase();
  if (/^[2-9TJQKA]+[+-]$/.test(s)) {
    const body = s.slice(0, -1);
    if (body.length < 2) return [atom];
    const dir = s.endsWith("+") ? 1 : -1;
    const a = RANK_ORDER.indexOf(body[0]);
    const b = RANK_ORDER.indexOf(body[1]);
    if (a < 0 || b < 0) return [atom];
    const out = [];
    let i = a;
    let j = b;
    while (i >= 0 && i < RANK_ORDER.length && j >= 0 && j < RANK_ORDER.length) {
      const p = RANK_ORDER[i] + RANK_ORDER[j] + body.slice(2);
      out.push(p);
      i += dir;
      j += dir;
    }
    return out;
  }

  const m = s.match(/^([2-9TJQKA]{2,6})-([2-9TJQKA]{2,6})$/);
  if (m && m[1].length === m[2].length) {
    const left = m[1];
    const right = m[2];
    const pairs = [];
    for (let i = 0; i < left.length; i++) {
      const li = RANK_ORDER.indexOf(left[i]);
      const ri = RANK_ORDER.indexOf(right[i]);
      if (li < 0 || ri < 0) return [atom];
      pairs.push([li, ri]);
    }
    const steps = Math.max(...pairs.map(([a, b]) => Math.abs(a - b))) + 1;
    const out = [];
    for (let step = 0; step < steps; step++) {
      let ok = true;
      let hand = "";
      for (const [a, b] of pairs) {
        const dir = Math.sign(b - a);
        const v = a + step * dir;
        if (v < 0 || v >= RANK_ORDER.length) {
          ok = false;
          break;
        }
        hand += RANK_ORDER[v];
      }
      if (ok) out.push(hand);
    }
    return out.length ? out : [atom];
  }

  return [atom];
}

function evaluateHeuristic(hand, variant) {
  const ranks = hand.map(rankOf).sort((a, b) => b - a);
  const suits = hand.map(suitOf);
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const freq = [...counts.values()].sort((a, b) => b - a);
  const maxSuit = [0, 0, 0, 0];
  for (const s of suits) maxSuit[s]++;
  const suitPeak = Math.max(...maxSuit);

  let score = 0;
  score += ranks.reduce((a, r) => a + r, 0) * (variant === "holdem" ? 2.7 : 1.8);
  if (freq[0] >= 2) score += 26 * freq[0];
  if (freq[1] >= 2) score += 8;

  const uniq = [...new Set(ranks)].sort((a, b) => a - b);
  let conn = 0;
  for (let i = 1; i < uniq.length; i++) {
    const d = uniq[i] - uniq[i - 1];
    if (d === 1) conn += 7;
    else if (d === 2) conn += 3;
  }
  score += conn;
  if (variant === "holdem") {
    if (suitPeak === 2) score += 7;
  } else {
    if (suitPeak >= 2) score += 6;
    if (suitPeak >= 3) score -= 2;
    if (suitPeak >= 4) score -= 5;
  }
  if (ranks.includes(14)) score += 5;
  return score;
}

function percentileThreshold(variant, p) {
  const key = `${variant}`;
  if (!percentileCache.has(key)) {
    const handSize = variant === "holdem" ? 2 : variant === "plo4" ? 4 : variant === "plo5" ? 5 : 6;
    const sample = [];
    for (let i = 0; i < 30000; i++) {
      const deck = Array.from({ length: 52 }, (_, x) => x);
      for (let j = 0; j < handSize; j++) {
        const pick = j + Math.floor(Math.random() * (52 - j));
        const t = deck[j];
        deck[j] = deck[pick];
        deck[pick] = t;
      }
      sample.push(evaluateHeuristic(deck.slice(0, handSize), variant));
    }
    sample.sort((a, b) => b - a);
    percentileCache.set(key, sample);
  }
  const arr = percentileCache.get(key);
  const idx = Math.max(0, Math.min(arr.length - 1, Math.floor((p / 100) * arr.length)));
  return arr[idx];
}

function atomCompiler(rawAtom, variant, contextBoard) {
  let atom = expandShortcuts(stripSpaces(rawAtom), variant);

  let weight = 100;
  const w = atom.match(/@([0-9]{1,3})$/);
  if (w) {
    weight = Math.max(0, Math.min(100, Number(w[1])));
    atom = atom.slice(0, atom.length - w[0].length);
  }

  const lowAtom = atom.toLowerCase();
  if (CATEGORY_TAGS.has(lowAtom)) {
    return {
      weight,
      predicate: (hand, _meta, helpers) => helpers.categoryMatch(lowAtom, hand, contextBoard)
    };
  }

  const pctRange = atom.match(/^([0-9]{1,2}(?:\.[0-9]+)?)%-([0-9]{1,2}(?:\.[0-9]+)?)%$/);
  if (pctRange) {
    const low = Number(pctRange[1]);
    const high = Number(pctRange[2]);
    const tHi = percentileThreshold(variant, low);
    const tLo = percentileThreshold(variant, high);
    return {
      weight,
      predicate: (hand) => {
        const s = evaluateHeuristic(hand, variant);
        return s <= tHi && s >= tLo;
      }
    };
  }

  const pctTop = atom.match(/^([0-9]{1,2}(?:\.[0-9]+)?)%$/);
  if (pctTop) {
    const p = Number(pctTop[1]);
    const threshold = percentileThreshold(variant, p);
    return {
      weight,
      predicate: (hand) => evaluateHeuristic(hand, variant) >= threshold
    };
  }

  const expanded = expandSpan(atom);
  const handSize = variant === "holdem" ? 2 : variant === "plo4" ? 4 : variant === "plo5" ? 5 : 6;
  const entries = expanded.map((x) => parseLeafSpecs(x));

  return {
    weight,
    predicate: (hand) => {
      return entries.some((entry) => matchSpecs(entry.specs, hand, handSize));
    }
  };
}

function cardRankChar(card) {
  return RANK_ORDER[rankOf(card) - 2];
}

function cardSuitChar(card) {
  return SUITS[suitOf(card)];
}

function matchSpecs(specsRaw, hand, handSize) {
  const specs = specsRaw.slice();
  while (specs.length < handSize) {
    specs.push({ ranks: new Set(RANK_ORDER), rankVar: null, suit: null });
  }
  if (specs.length > hand.length) return false;

  const used = new Array(hand.length).fill(false);
  const rankBindings = new Map();
  const suitBindings = new Map();
  const fixedRanks = new Set();
  for (const s of specs) {
    if (!s.rankVar && s.ranks.size === 1) fixedRanks.add([...s.ranks][0]);
  }

  function rec(i) {
    if (i === specs.length) return true;
    const spec = specs[i];
    for (let j = 0; j < hand.length; j++) {
      if (used[j]) continue;
      const c = hand[j];
      const r = cardRankChar(c);
      const s = cardSuitChar(c);
      if (!spec.ranks.has(r)) continue;

      if (spec.rankVar) {
        if (rankBindings.has(spec.rankVar)) {
          if (rankBindings.get(spec.rankVar) !== r) continue;
        } else {
          if (fixedRanks.has(r)) continue;
          rankBindings.set(spec.rankVar, r);
        }
      }

      if (spec.suit) {
        if (spec.suit.type === "fixed") {
          if (s !== spec.suit.value) {
            if (spec.rankVar && !rankBindings.has(spec.rankVar)) {}
            if (spec.rankVar && rankBindings.get(spec.rankVar) === r) {
              if ([...specs.slice(0, i), ...specs.slice(i + 1)].every((x) => x.rankVar !== spec.rankVar)) {
                rankBindings.delete(spec.rankVar);
              }
            }
            continue;
          }
        } else {
          const key = spec.suit.value;
          if (suitBindings.has(key)) {
            if (suitBindings.get(key) !== s) {
              if (spec.rankVar && ![...specs.slice(0, i), ...specs.slice(i + 1)].some((x) => x.rankVar === spec.rankVar)) {
                rankBindings.delete(spec.rankVar);
              }
              continue;
            }
          } else {
            if ([...suitBindings.values()].includes(s)) {
              if (spec.rankVar && ![...specs.slice(0, i), ...specs.slice(i + 1)].some((x) => x.rankVar === spec.rankVar)) {
                rankBindings.delete(spec.rankVar);
              }
              continue;
            }
            suitBindings.set(key, s);
          }
        }
      }

      used[j] = true;
      if (rec(i + 1)) return true;
      used[j] = false;

      if (spec.rankVar && !specs.slice(0, i).some((x) => x.rankVar === spec.rankVar)) {
        rankBindings.delete(spec.rankVar);
      }
      if (spec.suit && spec.suit.type === "var" && !specs.slice(0, i).some((x) => x.suit?.type === "var" && x.suit.value === spec.suit.value)) {
        suitBindings.delete(spec.suit.value);
      }
    }
    return false;
  }

  return rec(0);
}

function compileAst(ast, variant, board) {
  if (ast.kind === "atom") {
    return atomCompiler(ast.value, variant, board);
  }
  const left = compileAst(ast.left, variant, board);
  const right = compileAst(ast.right, variant, board);
  if (ast.kind === "or") {
    return {
      weight: 100,
      predicate: (hand, meta, helpers) => left.predicate(hand, meta, helpers) || right.predicate(hand, meta, helpers)
    };
  }
  if (ast.kind === "and") {
    return {
      weight: Math.min(left.weight, right.weight),
      predicate: (hand, meta, helpers) => left.predicate(hand, meta, helpers) && right.predicate(hand, meta, helpers)
    };
  }
  return {
    weight: Math.min(left.weight, right.weight),
    predicate: (hand, meta, helpers) => left.predicate(hand, meta, helpers) && !right.predicate(hand, meta, helpers)
  };
}

export function compileRange(rawExpr, variant, boardCards = []) {
  const expr = expandExprMacros(stripSpaces(rawExpr || "*"));
  if (!expr) {
    const ok = { predicate: () => true, weight: 100 };
    return ok;
  }
  const tokens = tokenizeExpr(expr);
  const ast = parser(tokens);
  return compileAst(ast, variant, boardCards);
}
