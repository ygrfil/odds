import {
  bestHoldemScore,
  bestOmahaScore,
  bestOmahaCore2ScoreStreet,
  bestHoldemScoreStreet,
  bestOmahaScoreStreet,
  classIdFromScore,
  classifyBoard,
  CLASS_NAMES
} from "./eval.js";
import { RANKS, SUITS, cardFromRankSuit, fullDeck, parseCards, rankOf, suitOf } from "./cards.js";
import { compileRange } from "./parser.js";
import { makeRng } from "./rng.js";

const ALL_CARDS = fullDeck();
const RANK_CHARS = "??23456789TJQKA";
const OMAHA_SD_PREVIEW_CACHE = new Map();
const TAG_COVERAGE_CACHE = new Map();

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function variantCardCount(variant) {
  if (variant === "holdem") return 2;
  if (variant === "plo4") return 4;
  if (variant === "plo5") return 5;
  if (variant === "plo6") return 6;
  throw new Error(`Unsupported variant: ${variant}`);
}

function isStraightClassId(cls) {
  return cls === 4 || cls === 8;
}

function isFiveRanksStraight(r1, r2, r3, r4, r5) {
  const mask = new Uint8Array(15);
  mask[r1] = 1; mask[r2] = 1; mask[r3] = 1; mask[r4] = 1; mask[r5] = 1;
  let uniq = 0;
  for (let r = 2; r <= 14; r++) if (mask[r]) uniq++;
  if (uniq !== 5) return false;
  for (let hi = 14; hi >= 6; hi--) {
    if (mask[hi] && mask[hi - 1] && mask[hi - 2] && mask[hi - 3] && mask[hi - 4]) return true;
  }
  return !!(mask[14] && mask[5] && mask[4] && mask[3] && mask[2]);
}

function hasHoldemStraightByRanks(hand, board) {
  const present = new Uint8Array(15);
  for (let i = 0; i < hand.length; i++) present[rankOf(hand[i])] = 1;
  for (let i = 0; i < board.length; i++) present[rankOf(board[i])] = 1;
  for (let hi = 14; hi >= 6; hi--) {
    if (present[hi] && present[hi - 1] && present[hi - 2] && present[hi - 3] && present[hi - 4]) return true;
  }
  return !!(present[14] && present[5] && present[4] && present[3] && present[2]);
}

function hasOmahaCoreStraight(core, board) {
  if (board.length < 3) return false;
  const hr1 = rankOf(core[0]);
  const hr2 = rankOf(core[1]);
  const n = board.length;
  for (let i = 0; i < n - 2; i++) {
    const r1 = rankOf(board[i]);
    for (let j = i + 1; j < n - 1; j++) {
      const r2 = rankOf(board[j]);
      for (let k = j + 1; k < n; k++) {
        const r3 = rankOf(board[k]);
        if (isFiveRanksStraight(hr1, hr2, r1, r2, r3)) return true;
      }
    }
  }
  return false;
}

function hasOmahaStraight(hand, board) {
  if (board.length < 3) return false;
  const hn = hand.length;
  for (let a = 0; a < hn - 1; a++) {
    for (let b = a + 1; b < hn; b++) {
      if (hasOmahaCoreStraight([hand[a], hand[b]], board)) return true;
    }
  }
  return false;
}

function straightOutCountNextCard(hand, board, isHoldem) {
  if (board.length >= 5) return 0;
  const used = new Uint8Array(52);
  for (let i = 0; i < hand.length; i++) used[hand[i]] = 1;
  for (let i = 0; i < board.length; i++) used[board[i]] = 1;
  let outs = 0;
  for (let c = 0; c < 52; c++) {
    if (used[c]) continue;
    const nextBoard = board.concat(c);
    const isStraight = isHoldem ? hasHoldemStraightByRanks(hand, nextBoard) : hasOmahaStraight(hand, nextBoard);
    if (isStraight) outs++;
  }
  return outs;
}

function minOutsForSdTag(tag) {
  if (tag === "@sd") return 1;
  if (tag === "@sd12" || tag === "@sd13") return 12;
  if (tag === "@sd8") return 8;
  if (tag === "@sd4") return 4;
  return 4;
}

function coreRankLabel(c1, c2) {
  const r1 = rankOf(c1);
  const r2 = rankOf(c2);
  const high = Math.max(r1, r2);
  const low = Math.min(r1, r2);
  const hasFaceNumMix = high >= 11 && low <= 10;
  const a = hasFaceNumMix ? RANK_CHARS[low] : RANK_CHARS[high];
  const b = hasFaceNumMix ? RANK_CHARS[high] : RANK_CHARS[low];
  return `${a}${b}`;
}

function coreSuitLabel(c1, c2) {
  const s1 = SUITS[suitOf(c1)];
  const s2 = SUITS[suitOf(c2)];
  if (s1 === s2) return `${s1}${s2}`;
  return `${s1}${s2}`;
}

function straightOutCountForCoreNextCard(core, board, isHoldem) {
  if (board.length >= 5) return 0;
  const used = new Uint8Array(52);
  used[core[0]] = 1;
  used[core[1]] = 1;
  for (let i = 0; i < board.length; i++) used[board[i]] = 1;
  let outs = 0;
  for (let c = 0; c < 52; c++) {
    if (used[c]) continue;
    const nextBoard = board.concat(c);
    const isStraight = isHoldem ? hasHoldemStraightByRanks(core, nextBoard) : hasOmahaCoreStraight(core, nextBoard);
    if (isStraight) outs++;
  }
  return outs;
}

function coreCategoryMatch(tag, core, board, variant) {
  if (board.length < 3) return false;
  const isHoldem = variant === "holdem";
  if (tag === "@overpair" && !isHoldem) return false;

  const boardSuitCnt = [0, 0, 0, 0];
  const coreSuitCnt = [0, 0, 0, 0];
  for (const c of board) boardSuitCnt[suitOf(c)]++;
  coreSuitCnt[suitOf(core[0])]++;
  coreSuitCnt[suitOf(core[1])]++;

  let madeFlush = false;
  let flushDraw = false;
  for (let s = 0; s < 4; s++) {
    if (isHoldem) {
      const total = boardSuitCnt[s] + coreSuitCnt[s];
      if (total >= 5) madeFlush = true;
      if (!madeFlush && board.length < 5 && total === 4) flushDraw = true;
    } else {
      if (coreSuitCnt[s] >= 2 && boardSuitCnt[s] >= 3) madeFlush = true;
      if (!madeFlush && board.length < 5 && coreSuitCnt[s] >= 2 && boardSuitCnt[s] === 2) flushDraw = true;
    }
  }

  if (tag === "@fd") return flushDraw;
  if (tag === "@flush") return madeFlush;

  const score = isHoldem ? bestHoldemScoreStreet(core, board) : bestOmahaCore2ScoreStreet(core, board);
  const cls = classIdFromScore(score);

  if (tag === "@2p") return cls === 2;
  if (tag === "@set") return cls === 3;
  if (tag === "@straight") return isStraightClassId(cls);

  if (tag === "@sd" || tag === "@sd4" || tag === "@sd8" || tag === "@sd12" || tag === "@sd13") {
    const hasStraightNow = isHoldem ? hasHoldemStraightByRanks(core, board) : hasOmahaCoreStraight(core, board);
    if (board.length >= 5 || hasStraightNow) return false;
    const outs = straightOutCountForCoreNextCard(core, board, isHoldem);
    return outs >= minOutsForSdTag(tag);
  }

  const ranks = [rankOf(core[0]), rankOf(core[1]), ...board.map(rankOf)];
  const cnt = new Uint8Array(15);
  for (const r of ranks) cnt[r]++;
  let top = 0;
  for (let r = 2; r <= 14; r++) if (cnt[r] > top) top = cnt[r];

  if (tag === "@tpplus") return cls >= 1 || top >= 2 || madeFlush;
  if (tag === "@overpair") {
    const pocket = rankOf(core[0]) === rankOf(core[1]);
    if (!pocket) return false;
    const topBoard = Math.max(...board.map(rankOf));
    return rankOf(core[0]) > topBoard;
  }

  return false;
}

function formatRankComboUser(ranks) {
  const uniq = [...new Set(ranks)].sort((a, b) => a - b);
  const nums = uniq.filter((r) => r <= 10);
  const faces = uniq.filter((r) => r >= 11);
  if (faces.length === 1 && nums.length === 2 && uniq.length === 3) {
    const p = nums.slice().sort((a, b) => b - a).map((r) => RANK_CHARS[r]).join("");
    return `${p}${RANK_CHARS[faces[0]]}`;
  }
  if (faces.length === 1 && nums.length === 3 && uniq.length === 4) {
    const p = nums.slice().sort((a, b) => a - b).map((r) => RANK_CHARS[r]).join("");
    return `${p}${RANK_CHARS[faces[0]]}`;
  }
  return uniq.map((r) => RANK_CHARS[r]).join("");
}

function straightOutCountOmahaHandNextCard(hand, board) {
  if (board.length >= 5) return 0;
  const used = new Uint8Array(52);
  for (let i = 0; i < hand.length; i++) used[hand[i]] = 1;
  for (let i = 0; i < board.length; i++) used[board[i]] = 1;
  let outs = 0;
  for (let c = 0; c < 52; c++) {
    if (used[c]) continue;
    if (hasOmahaStraight(hand, board.concat(c))) outs++;
  }
  return outs;
}

function buildCardsFromRanksForBoard(ranks, boardMask) {
  const hand = [];
  const used = new Uint8Array(52);
  for (let i = 0; i < ranks.length; i++) {
    const r = ranks[i];
    let picked = -1;
    for (let s = 0; s < 4; s++) {
      const c = (r - 2) * 4 + s;
      if (boardMask[c] || used[c]) continue;
      picked = c;
      break;
    }
    if (picked === -1) return null;
    used[picked] = 1;
    hand.push(picked);
  }
  return hand;
}

function previewOmahaSdStructures(boardText, variant, tag) {
  const cacheKey = `${variant}|${tag}|${boardText}`;
  if (OMAHA_SD_PREVIEW_CACHE.has(cacheKey)) return OMAHA_SD_PREVIEW_CACHE.get(cacheKey).slice();

  const board = parseCards(boardText || "");
  if (board.length < 3 || board.length > 4) return [];
  const threshold = minOutsForSdTag(tag);
  const boardMask = new Uint8Array(52);
  const boardRankCnt = new Uint8Array(15);
  for (let i = 0; i < board.length; i++) {
    const c = board[i];
    boardMask[c] = 1;
    boardRankCnt[rankOf(c)]++;
  }

  const raw4 = [];
  const trioToKickers = new Map();

  for (let a = 14; a >= 2; a--) {
    for (let b = a; b >= 2; b--) {
      for (let c = b; c >= 2; c--) {
        for (let d = c; d >= 2; d--) {
          const ranks = [a, b, c, d];
          const cnt = new Uint8Array(15);
          cnt[a]++; cnt[b]++; cnt[c]++; cnt[d]++;
          let feasible = true;
          for (let r = 2; r <= 14; r++) {
            if (cnt[r] > 0 && cnt[r] + boardRankCnt[r] > 4) {
              feasible = false;
              break;
            }
          }
          if (!feasible) continue;

          const hand = buildCardsFromRanksForBoard(ranks, boardMask);
          if (!hand) continue;
          if (hasOmahaStraight(hand, board)) continue;
          const outs = straightOutCountOmahaHandNextCard(hand, board);
          if (outs < threshold) continue;

          const uniq4 = [...new Set(ranks)].sort((x, y) => x - y);
          raw4.push({ ranks: uniq4, label: formatRankComboUser(ranks) });

          if (uniq4.length === 4) {
            for (let i = 0; i < 4; i++) {
              const trio = uniq4.filter((_, idx) => idx !== i);
              const kicker = uniq4[i];
              const key = trio.join("-");
              if (!trioToKickers.has(key)) trioToKickers.set(key, new Set());
              trioToKickers.get(key).add(kicker);
            }
          }
        }
      }
    }
  }

  const compressTrios = new Set();
  for (const [k, kickers] of trioToKickers.entries()) {
    const trioLen = k.split("-").length;
    const neededDistinctKickers = Math.max(1, 13 - trioLen);
    if (kickers.size >= neededDistinctKickers) compressTrios.add(k);
  }
  let out3 = [...compressTrios]
    .map((k) => formatRankComboUser(k.split("-").map(Number)))
    .sort();

  const out4set = new Set();
  for (let i = 0; i < raw4.length; i++) {
    const item = raw4[i];
    let coveredByWildcardTrio = false;
    if (item.ranks.length === 4) {
      for (let j = 0; j < 4; j++) {
        const trio = item.ranks.filter((_, idx) => idx !== j).join("-");
        if (compressTrios.has(trio)) {
          coveredByWildcardTrio = true;
          break;
        }
      }
    }
    if (!coveredByWildcardTrio) out4set.add(item.label);
  }
  let out4 = [...out4set].sort();
  const handSize = variantCardCount(variant);
  if (handSize > 4) {
    const x3 = "x".repeat(Math.max(0, handSize - 3));
    const x4 = "x".repeat(Math.max(0, handSize - 4));
    out3 = out3.map((s) => `${s}${x3}`);
    out4 = out4.map((s) => `${s}${x4}`);
  }

  const combined = [...new Set(out4.concat(out3))];

  // If a 2-rank structure exists (e.g. "68"), remove any longer structure
  // that is fully covered by that wildcard family (e.g. "689", "689J", ...).
  const rankSet = (label) => {
    const base = String(label).replace(/x+$/g, "");
    const set = new Set();
    for (let i = 0; i < base.length; i++) {
      const ch = base[i];
      if ("23456789TJQKA".includes(ch)) set.add(ch);
    }
    return set;
  };
  const covers = (small, big) => {
    if (small.size >= big.size) return false;
    for (const ch of small) {
      if (!big.has(ch)) return false;
    }
    return true;
  };
  const twoRankSets = combined
    .map((label) => ({ label, set: rankSet(label) }))
    .filter((x) => x.set.size === 2)
    .map((x) => x.set);

  const pruned = combined.filter((label) => {
    const s = rankSet(label);
    if (s.size <= 2) return true;
    for (let i = 0; i < twoRankSets.length; i++) {
      if (covers(twoRankSets[i], s)) return false;
    }
    return true;
  });

  const out = pruned.slice(0, 280);
  OMAHA_SD_PREVIEW_CACHE.set(cacheKey, out.slice());
  return out;
}

export function previewTagCoreCombos(boardText, variant, tag) {
  const board = parseCards(boardText || "");
  if (board.length < 3 || board.length > 5) return [];
  const knownTags = new Set(["@set", "@2p", "@fd", "@sd", "@sd4", "@sd8", "@sd12", "@sd13", "@flush", "@straight", "@tpplus", "@overpair"]);
  if (!knownTags.has(tag)) return [];
  if (variant !== "holdem" && (tag === "@sd" || tag === "@sd4" || tag === "@sd8" || tag === "@sd12" || tag === "@sd13")) {
    return previewOmahaSdStructures(boardText, variant, tag);
  }

  const blocked = new Uint8Array(52);
  for (const c of board) blocked[c] = 1;
  const labels = new Set();

  for (let c1 = 0; c1 < 52; c1++) {
    if (blocked[c1]) continue;
    for (let c2 = c1 + 1; c2 < 52; c2++) {
      if (blocked[c2]) continue;
      const core = [c1, c2];
      if (!coreCategoryMatch(tag, core, board, variant)) continue;
      if (tag === "@fd" || tag === "@flush") labels.add(coreSuitLabel(c1, c2));
      else labels.add(coreRankLabel(c1, c2));
    }
  }

  return [...labels];
}

export function previewTagCoverage(boardText, variant, tag) {
  const k = `${variant}|${tag}|${boardText}`;
  if (TAG_COVERAGE_CACHE.has(k)) return TAG_COVERAGE_CACHE.get(k);
  const board = parseCards(boardText || "");
  if (board.length < 3 || board.length > 5) {
    const z = { matched: 0, total: 0, pct: 0, approx: false };
    TAG_COVERAGE_CACHE.set(k, z);
    return z;
  }

  if (variant !== "holdem") {
    const blocked = new Set(board);
    const deck = ALL_CARDS.filter((c) => !blocked.has(c));
    const handSize = variantCardCount(variant);
    const sampleN = handSize === 4 ? 5000 : handSize === 5 ? 4000 : 3000;
    const sampleSeed = hash32(`${variant}|${board.join(",")}|${handSize}`) || 1;
    const rng = makeRng(sampleSeed);
    const scratch = [];
    let matched = 0;
    for (let i = 0; i < sampleN; i++) {
      if (!pickDistinct(deck, handSize, rng, scratch)) break;
      if (categoryMatch(tag, scratch, board)) matched++;
    }
    const out = { matched, total: sampleN, pct: sampleN > 0 ? (matched * 100) / sampleN : 0, approx: true };
    TAG_COVERAGE_CACHE.set(k, out);
    return out;
  }

  const blocked = new Uint8Array(52);
  for (const c of board) blocked[c] = 1;
  let matched = 0;
  let total = 0;
  for (let c1 = 0; c1 < 52; c1++) {
    if (blocked[c1]) continue;
    for (let c2 = c1 + 1; c2 < 52; c2++) {
      if (blocked[c2]) continue;
      total++;
      if (coreCategoryMatch(tag, [c1, c2], board, variant)) matched++;
    }
  }
  const out = { matched, total, pct: total > 0 ? (matched * 100) / total : 0, approx: false };
  TAG_COVERAGE_CACHE.set(k, out);
  return out;
}

export function previewHoldemStraightDrawRankCombos(boardText, minOuts = 1) {
  if (minOuts <= 1) return previewTagCoreCombos(boardText, "holdem", "@sd");
  if (minOuts <= 4) return previewTagCoreCombos(boardText, "holdem", "@sd4");
  if (minOuts <= 8) return previewTagCoreCombos(boardText, "holdem", "@sd8");
  return previewTagCoreCombos(boardText, "holdem", "@sd12");
}

function categoryMatch(tag, hand, board) {
  if (board.length < 3) return false;
  const isHoldem = hand.length === 2;

  const boardSuitCnt = [0, 0, 0, 0];
  const handSuitCnt = [0, 0, 0, 0];
  for (const c of board) boardSuitCnt[c % 4]++;
  for (const c of hand) handSuitCnt[c % 4]++;

  let madeFlush = false;
  let flushDraw = false;
  for (let s = 0; s < 4; s++) {
    if (isHoldem) {
      const total = boardSuitCnt[s] + handSuitCnt[s];
      if (total >= 5) madeFlush = true;
      if (!madeFlush && board.length < 5 && total === 4) flushDraw = true;
    } else {
      if (handSuitCnt[s] >= 2 && boardSuitCnt[s] >= 3) madeFlush = true;
      if (!madeFlush && board.length < 5 && handSuitCnt[s] >= 2 && boardSuitCnt[s] === 2) flushDraw = true;
    }
  }

  if (tag === "@fd") return flushDraw;
  if (tag === "@flush") return madeFlush;

  const score = isHoldem ? bestHoldemScoreStreet(hand, board) : bestOmahaScoreStreet(hand, board);
  const cls = classIdFromScore(score);

  if (tag === "@2p") return cls === 2;
  if (tag === "@set") return cls === 3;
  if (tag === "@straight") return isStraightClassId(cls);
  if (tag === "@sd" || tag === "@sd4" || tag === "@sd8" || tag === "@sd12" || tag === "@sd13") {
    const hasStraightNow = isHoldem ? hasHoldemStraightByRanks(hand, board) : hasOmahaStraight(hand, board);
    if (board.length >= 5 || hasStraightNow) return false;
    const outs = straightOutCountNextCard(hand, board, isHoldem);
    return outs >= minOutsForSdTag(tag);
  }

  const ranks = hand.concat(board).map(rankOf);
  const cnt = new Uint8Array(15);
  for (const r of ranks) cnt[r]++;
  let top = 0;
  for (let r = 2; r <= 14; r++) if (cnt[r] > top) top = cnt[r];

  if (tag === "@tpplus") return cls >= 1 || top >= 2 || madeFlush;

  if (tag === "@overpair") {
    if (!isHoldem || board.length < 3) return false;
    const pocket = rankOf(hand[0]) === rankOf(hand[1]);
    if (!pocket) return false;
    const topBoard = Math.max(...board.map(rankOf));
    return rankOf(hand[0]) > topBoard;
  }
  return false;
}

function fillAvailable(baseDeck, usedFlags, out) {
  out.length = 0;
  for (let i = 0; i < baseDeck.length; i++) {
    const c = baseDeck[i];
    if (!usedFlags[c]) out.push(c);
  }
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

function randomBoardRunout(knownBoard, available, rng, out) {
  out.length = 0;
  for (let i = 0; i < knownBoard.length; i++) out.push(knownBoard[i]);
  const needed = 5 - knownBoard.length;
  if (needed <= 0) return out;
  const add = [];
  if (!pickDistinct(available, needed, rng, add)) return null;
  for (let i = 0; i < add.length; i++) out.push(add[i]);
  return out;
}

function sampleHandFromRange(rangeCompiled, availableCards, handSize, rng, helpers, scratch) {
  const maxAttempts = 5000;
  for (let tries = 0; tries < maxAttempts; tries++) {
    if (!pickDistinct(availableCards, handSize, rng, scratch)) return null;
    if (!rangeCompiled.predicate(scratch, null, helpers)) continue;
    if (rng() * 100 > rangeCompiled.weight) continue;
    return scratch.slice();
  }
  return null;
}

function comboKey(hand) {
  return hand.slice().sort((a, b) => a - b).join("-");
}

function shouldUsePool(rangeText, boardLen, handSize) {
  const t = (rangeText || "").toLowerCase();
  if (!t) return false;
  // Category filters are the main rejection-sampling bottleneck on postflop boards.
  if (t.includes("@")) return boardLen >= 3;
  // Weighted ranges can also suffer from high rejection for low weights.
  if (t.includes("@") || t.match(/@[0-9]{1,3}\b/)) return true;
  // For large-card games, any explicit suit-heavy constraint benefits from pooling.
  if (handSize >= 4 && (t.includes("xxyy") || t.includes("xxyz") || t.includes("!rrr") || t.includes("!rr"))) return boardLen >= 3;
  return false;
}

function tryParseExactLiteral(rangeText, handSize) {
  const t = (rangeText || "").replace(/\s+/g, "");
  if (!t || /[,:!()@$\[\]{}%&*xXyYzZwWrRoOnN+\-]/.test(t)) return null;
  if (t.length !== handSize * 2) return null;
  try {
    const cards = parseCards(t);
    if (cards.length !== handSize) return null;
    return cards;
  } catch {
    return null;
  }
}

function parseExactLiteralOrThrow(rangeText, handSize, label) {
  const parsed = tryParseExactLiteral(rangeText, handSize);
  if (!parsed) {
    throw new Error(`${label} must be an exact suited hand in exhaustive mode.`);
  }
  return parsed;
}

function tryParseFixedPattern(rangeText, handSize) {
  const t = (rangeText || "").replace(/\s+/g, "");
  if (!t) return null;
  if (/[,:!()@$\[\]{}%&*xXyYzZwWrRoOnN+\-]/.test(t)) return null;
  const tokens = [];
  for (let i = 0; i < t.length;) {
    const r = t[i].toUpperCase();
    if (!RANKS.includes(r)) return null;
    let suit = null;
    if (i + 1 < t.length) {
      const s = t[i + 1].toLowerCase();
      if (SUITS.includes(s)) {
        suit = s;
        i += 2;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
    tokens.push({ rank: r, suit });
  }
  if (tokens.length !== handSize) return null;
  return tokens;
}

function buildPoolFromFixedPattern(tokens, baseMask) {
  const perPos = tokens.map((tok) => {
    if (tok.suit) return [cardFromRankSuit(tok.rank, tok.suit)];
    return [...SUITS].map((s) => cardFromRankSuit(tok.rank, s));
  });

  const used = new Uint8Array(52);
  const cur = [];
  const seen = new Set();
  const pool = [];

  function rec(pos) {
    if (pos === perPos.length) {
      const hand = cur.slice();
      const k = comboKey(hand);
      if (!seen.has(k)) {
        seen.add(k);
        pool.push(hand);
      }
      return;
    }
    const options = perPos[pos];
    for (let i = 0; i < options.length; i++) {
      const c = options[i];
      if (!baseMask[c] || used[c]) continue;
      used[c] = 1;
      cur.push(c);
      rec(pos + 1);
      cur.pop();
      used[c] = 0;
    }
  }

  rec(0);
  return pool;
}

function estimateAcceptance(rangeCompiled, baseDeck, handSize, rng, helpers, trials = 300) {
  let ok = 0;
  const tmp = [];
  for (let i = 0; i < trials; i++) {
    if (!pickDistinct(baseDeck, handSize, rng, tmp)) break;
    if (!rangeCompiled.predicate(tmp, null, helpers)) continue;
    if (rng() * 100 > rangeCompiled.weight) continue;
    ok++;
  }
  return ok / Math.max(1, trials);
}

function buildCandidatePool(rangeCompiled, baseDeck, handSize, rng, helpers, targetSize, maxTrials) {
  const pool = [];
  const seen = new Set();
  const tmp = [];
  let accepted = 0;
  const start = performance.now();
  const budgetMs = 450;
  for (let i = 0; i < maxTrials; i++) {
    if (performance.now() - start > budgetMs) break;
    if (!pickDistinct(baseDeck, handSize, rng, tmp)) break;
    if (!rangeCompiled.predicate(tmp, null, helpers)) continue;
    if (rng() * 100 > rangeCompiled.weight) continue;
    accepted++;
    const k = comboKey(tmp);
    if (!seen.has(k)) {
      seen.add(k);
      pool.push(tmp.slice());
      if (pool.length >= targetSize) break;
    }
  }
  return { pool, accepted };
}

function sampleFromPool(pool, usedFlags, rng) {
  if (!pool || pool.length === 0) return null;
  const maxTries = 200;
  for (let t = 0; t < maxTries; t++) {
    const hand = pool[Math.floor(rng() * pool.length)];
    let ok = true;
    for (let i = 0; i < hand.length; i++) {
      if (usedFlags[hand[i]]) {
        ok = false;
        break;
      }
    }
    if (ok) return hand;
  }
  return null;
}

export function rawToResult(raw, config) {
  const { iterations: it, elapsedMs, wins, ties, losses, comboLists, classCounts, equityShares } = raw;
  const players = config.players;
  const n = players.length;
  const rows = players.map((p, i) => {
    const eqShare = equityShares?.[i] ?? (wins[i] + ties[i] / n);
    const equity = (eqShare / Math.max(1, it)) * 100;
    const winPct = (wins[i] / Math.max(1, it)) * 100;
    const tiePct = (ties[i] / Math.max(1, it)) * 100;
    const lossPct = (losses[i] / Math.max(1, it)) * 100;

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
      combos: comboLists[i].size,
      classes
    };
  });

  return {
    iterations: it,
    elapsedMs,
    aborted: !!raw.aborted,
    method: raw.method || config.method || "monte",
    variant: config.variant,
    players: rows,
    input: {
      board: config.board,
      dead: config.dead
    }
  };
}

export async function runSimulationRaw(config, options = {}) {
  const variant = config.variant;
  const players = config.players;
  const handSize = variantCardCount(variant);
  const rng = makeRng(options.seedOverride ?? config.seed);

  if (players.length < 2) throw new Error("At least 2 players required");
  if (players.length > 6) throw new Error("Max 6 players supported");

  const board = parseCards(config.board || "");
  if (board.length > 5) throw new Error("Board can have at most 5 cards");
  const dead = parseCards(config.dead || "");

  const blocked = new Set(board.concat(dead));
  const baseDeck = ALL_CARDS.filter((c) => !blocked.has(c));
  const baseMask = new Uint8Array(52);
  for (let i = 0; i < baseDeck.length; i++) baseMask[baseDeck[i]] = 1;
  const ranges = players.map((p) => compileRange((p.range || "*").trim() || "*", variant, board));
  const poolScale = Number.isFinite(options.poolScale) ? Math.max(0.1, Math.min(1, options.poolScale)) : 1;
  const samplerPlans = players.map((p, i) => ({
    rangeText: (p.range || "*").trim() || "*",
    compiled: ranges[i],
    pool: null
  }));

  const wins = players.map(() => 0);
  const ties = players.map(() => 0);
  const losses = players.map(() => 0);
  const equityShares = players.map(() => 0);
  const comboLists = players.map(() => new Set());
  const classCounts = players.map(() => new Array(CLASS_NAMES.length).fill(0));

  const start = performance.now();
  const capMs = Number.isFinite(options.capMs) ? options.capMs : Number.POSITIVE_INFINITY;
  const iterCapRaw = Number(options.iterCap ?? config.iterationCap ?? 100000);
  const iterCap = Number.isFinite(iterCapRaw) ? Math.max(1, Math.floor(iterCapRaw)) : 100000;

  let it = 0;
  let loops = 0;
  let lastProgress = start;
  let lastYield = start;

  const helpers = { categoryMatch };
  const usedFlags = new Uint8Array(52);
  const available = [];
  const board5 = [];
  const handScratch = [];
  const holeCards = [];

  for (let i = 0; i < samplerPlans.length; i++) {
    const s = samplerPlans[i];
    const fixed = tryParseFixedPattern(s.rangeText, handSize);
    if (fixed) {
      const pool = buildPoolFromFixedPattern(fixed, baseMask);
      if (pool.length === 0) throw new Error(`Player ${i + 1} range appears empty on this board/dead-card setup`);
      s.pool = pool;
      continue;
    }

    const exact = tryParseExactLiteral(s.rangeText, handSize);
    if (exact) {
      if (s.compiled.predicate(exact, null, helpers)) {
        s.pool = [exact];
        continue;
      }
      throw new Error(`Player ${i + 1} exact hand is invalid on this board/dead-card setup`);
    }

    let needsPool = shouldUsePool(s.rangeText, board.length, handSize);
    if (!needsPool) {
      // Auto-detect narrow ranges (e.g. exact hand literals) that are too slow with rejection sampling.
      const acceptance = estimateAcceptance(s.compiled, baseDeck, handSize, rng, helpers, 350);
      if (acceptance > 0 && acceptance < 0.03) needsPool = true;
    }
    if (!needsPool) continue;
    const baseTarget = handSize <= 2 ? 1200 : handSize <= 4 ? 1800 : 2200;
    const baseTrials = handSize <= 2 ? 60000 : handSize <= 4 ? 90000 : 130000;
    const targetSize = Math.max(600, Math.floor(baseTarget * poolScale));
    const maxTrials = Math.max(30000, Math.floor(baseTrials * poolScale));
    const built = buildCandidatePool(s.compiled, baseDeck, handSize, rng, helpers, targetSize, maxTrials);
    if (built.pool.length > 0) {
      s.pool = built.pool;
    } else if (built.accepted === 0) {
      throw new Error(`Player ${i + 1} range appears empty on this board/dead-card setup`);
    }
  }

  while (it < iterCap) {
    loops++;
    if (options.signal?.aborted) break;
    const now = performance.now();
    if (now - start >= capMs) break;
    if ((loops & 1023) === 0 && now - lastYield > 16) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
      if (options.signal?.aborted) break;
    }

    usedFlags.fill(0);
    for (const c of blocked) usedFlags[c] = 1;
    holeCards.length = 0;
    let failed = false;

    for (let i = 0; i < players.length; i++) {
      fillAvailable(baseDeck, usedFlags, available);
      const pooled = sampleFromPool(samplerPlans[i].pool, usedFlags, rng);
      const hand = pooled ? pooled.slice() : sampleHandFromRange(samplerPlans[i].compiled, available, handSize, rng, helpers, handScratch);
      if (!hand) {
        failed = true;
        break;
      }
      for (const c of hand) usedFlags[c] = 1;
      holeCards.push(hand);
      comboLists[i].add(comboKey(hand));
    }
    if (failed) continue;

    fillAvailable(baseDeck, usedFlags, available);
    if (!randomBoardRunout(board, available, rng, board5)) continue;

    const scores = holeCards.map((h) => variant === "holdem" ? bestHoldemScore(h, board5) : bestOmahaScore(h, board5));
    let maxScore = -1;
    for (let i = 0; i < scores.length; i++) if (scores[i] > maxScore) maxScore = scores[i];

    const winners = new Array(players.length).fill(false);
    let winnerCount = 0;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] === maxScore) {
        winners[i] = true;
        winnerCount++;
      }
      const cIdx = Math.floor(scores[i] / 1_000_000);
      classCounts[i][cIdx]++;
    }

    for (let i = 0; i < players.length; i++) {
      if (winners[i]) {
        if (winnerCount === 1) wins[i]++;
        else ties[i]++;
        equityShares[i] += 1 / winnerCount;
      } else {
        losses[i]++;
      }
    }

    it++;

    if (options.onProgress && performance.now() - lastProgress > 300) {
      const elapsed = (performance.now() - start) / 1000;
      options.onProgress({ iterations: it, elapsed, boardClass: classifyBoard(board5), ips: it / Math.max(0.001, elapsed) });
      lastProgress = performance.now();
    }
  }

  return {
    iterations: it,
    elapsedMs: performance.now() - start,
    wins,
    ties,
    losses,
    equityShares,
    comboLists,
    classCounts
  };
}

export async function runExhaustiveRaw(config, options = {}) {
  const variant = config.variant;
  const players = config.players;
  const handSize = variantCardCount(variant);
  if (players.length < 2) throw new Error("At least 2 players required");
  if (players.length > 6) throw new Error("Max 6 players supported");

  const boardKnown = parseCards(config.board || "");
  if (boardKnown.length > 5) throw new Error("Board can have at most 5 cards");
  const dead = parseCards(config.dead || "");

  const parsedHands = players.map((p, i) =>
    parseExactLiteralOrThrow((p.range || "").trim(), handSize, `Player ${i + 1}`)
  );

  const blocked = new Set(boardKnown.concat(dead));
  for (let i = 0; i < parsedHands.length; i++) {
    for (const c of parsedHands[i]) {
      if (blocked.has(c)) throw new Error(`Player ${i + 1} exact hand conflicts with board/dead cards.`);
      blocked.add(c);
    }
  }

  const deck = ALL_CARDS.filter((c) => !blocked.has(c));
  const need = 5 - boardKnown.length;
  if (need < 0) throw new Error("Invalid board size.");

  const wins = players.map(() => 0);
  const ties = players.map(() => 0);
  const losses = players.map(() => 0);
  const equityShares = players.map(() => 0);
  const comboLists = players.map((_, i) => new Set([comboKey(parsedHands[i])]));
  const classCounts = players.map(() => new Array(CLASS_NAMES.length).fill(0));

  const start = performance.now();
  const board5 = boardKnown.slice();
  const chosen = [];
  let assigned = 0;
  let visited = 0;
  let lastProgress = start;

  const partitionIndex = Math.max(0, Number(options.partitionIndex || 0));
  const partitionCount = Math.max(1, Number(options.partitionCount || 1));

  function evalBoard(board) {
    const scores = parsedHands.map((h) =>
      variant === "holdem" ? bestHoldemScore(h, board) : bestOmahaScore(h, board)
    );
    let maxScore = -1;
    for (let i = 0; i < scores.length; i++) if (scores[i] > maxScore) maxScore = scores[i];
    const winners = [];
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] === maxScore) winners.push(i);
      classCounts[i][Math.floor(scores[i] / 1_000_000)]++;
    }
    for (let i = 0; i < players.length; i++) {
      if (winners.includes(i)) {
        if (winners.length === 1) wins[i]++;
        else ties[i]++;
        equityShares[i] += 1 / winners.length;
      } else {
        losses[i]++;
      }
    }
  }

  function recurse(startIdx, depth) {
    if (options.signal?.aborted) return;
    if (depth === need) {
      if ((visited % partitionCount) === partitionIndex) {
        board5.length = boardKnown.length;
        for (let i = 0; i < chosen.length; i++) board5.push(chosen[i]);
        evalBoard(board5);
        assigned++;
        const now = performance.now();
        if (options.onProgress && now - lastProgress > 300) {
          const elapsed = (now - start) / 1000;
          options.onProgress({
            iterations: assigned,
            elapsed,
            boardClass: classifyBoard(board5),
            ips: assigned / Math.max(0.001, elapsed)
          });
          lastProgress = now;
        }
      }
      visited++;
      return;
    }
    for (let i = startIdx; i <= deck.length - (need - depth); i++) {
      if (options.signal?.aborted) return;
      chosen.push(deck[i]);
      recurse(i + 1, depth + 1);
      chosen.pop();
    }
  }

  if (need === 0) {
    if ((visited % partitionCount) === partitionIndex) {
      evalBoard(boardKnown);
      assigned++;
    }
    visited++;
  } else {
    recurse(0, 0);
  }

  return {
    iterations: assigned,
    elapsedMs: performance.now() - start,
    wins,
    ties,
    losses,
    equityShares,
    comboLists,
    classCounts
  };
}
