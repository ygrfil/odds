import {
  bestHoldemScore,
  bestOmahaScore,
  bestOmahaCore2ScoreStreet,
  bestHoldemScoreStreet,
  classIdFromScore,
  classifyBoard,
  CLASS_NAMES
} from "./eval.js";
import { RANKS, SUITS, cardFromRankSuit, fullDeck, parseCards, rankOf, suitOf } from "./cards.js";
import { compileRange, compileRangeAsync } from "./parser.js";
import { makeRng } from "./rng.js";
import { normalizeTagToken, splitTagToken } from "./tag-utils.js";

const ALL_CARDS = fullDeck();
const RANK_CHARS = "??23456789TJQKA";
const OMAHA_SD_PREVIEW_CACHE = new Map();
const TAG_COVERAGE_CACHE = new Map();
const RANGE_COVERAGE_CACHE = new Map();
const TAG_SHORTCUT_CACHE = new Map();

function nChooseK(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let num = 1;
  for (let i = 1; i <= kk; i++) {
    num = (num * (n - kk + i)) / i;
  }
  return Math.round(num);
}

function exactCoverage(deck, handSize, predicate) {
  const hand = new Array(handSize);
  let matched = 0;
  let total = 0;

  function rec(start, depth) {
    if (depth === handSize) {
      total++;
      if (predicate(hand)) matched++;
      return;
    }
    for (let i = start; i <= deck.length - (handSize - depth); i++) {
      hand[depth] = deck[i];
      rec(i + 1, depth + 1);
    }
  }

  rec(0, 0);
  return { matched, total, pct: total > 0 ? (matched * 100) / total : 0, approx: false };
}

function variantCardCount(variant) {
  if (variant === "holdem") return 2;
  if (variant === "plo4") return 4;
  if (variant === "plo5") return 5;
  if (variant === "plo6") return 6;
  throw new Error(`Unsupported variant: ${variant}`);
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

function hasHoldemStraightByRankValues(hr1, hr2, boardRanks) {
  const present = new Uint8Array(15);
  present[hr1] = 1;
  present[hr2] = 1;
  for (let i = 0; i < boardRanks.length; i++) present[boardRanks[i]] = 1;
  for (let hi = 14; hi >= 6; hi--) {
    if (present[hi] && present[hi - 1] && present[hi - 2] && present[hi - 3] && present[hi - 4]) return true;
  }
  return !!(present[14] && present[5] && present[4] && present[3] && present[2]);
}

function hasHoldemStraightByRanks(hand, board) {
  const boardRanks = new Array(board.length);
  for (let i = 0; i < board.length; i++) boardRanks[i] = rankOf(board[i]);
  return hasHoldemStraightByRankValues(rankOf(hand[0]), rankOf(hand[1]), boardRanks);
}

function hasOmahaCoreStraightRanks(hr1, hr2, boardRanks) {
  if (boardRanks.length < 3) return false;
  const n = boardRanks.length;
  for (let i = 0; i < n - 2; i++) {
    const r1 = boardRanks[i];
    for (let j = i + 1; j < n - 1; j++) {
      const r2 = boardRanks[j];
      for (let k = j + 1; k < n; k++) {
        const r3 = boardRanks[k];
        if (isFiveRanksStraight(hr1, hr2, r1, r2, r3)) return true;
      }
    }
  }
  return false;
}

function hasOmahaCoreStraight(core, board) {
  if (board.length < 3) return false;
  const boardRanks = new Array(board.length);
  for (let i = 0; i < board.length; i++) boardRanks[i] = rankOf(board[i]);
  return hasOmahaCoreStraightRanks(rankOf(core[0]), rankOf(core[1]), boardRanks);
}

function hasOmahaStraightByRankValues(hand, boardRanks) {
  if (boardRanks.length < 3) return false;
  for (let a = 0; a < hand.length - 1; a++) {
    const hr1 = rankOf(hand[a]);
    for (let b = a + 1; b < hand.length; b++) {
      const hr2 = rankOf(hand[b]);
      if (hasOmahaCoreStraightRanks(hr1, hr2, boardRanks)) return true;
    }
  }
  return false;
}

function hasOmahaStraight(hand, board) {
  if (board.length < 3) return false;
  const boardRanks = new Array(board.length);
  for (let i = 0; i < board.length; i++) boardRanks[i] = rankOf(board[i]);
  return hasOmahaStraightByRankValues(hand, boardRanks);
}

function straightOutCountNextCard(hand, board, isHoldem) {
  if (board.length >= 5) return 0;
  const boardRanks = new Array(board.length);
  for (let i = 0; i < board.length; i++) boardRanks[i] = rankOf(board[i]);
  const usedRankCount = new Uint8Array(15);
  for (let i = 0; i < hand.length; i++) usedRankCount[rankOf(hand[i])]++;
  for (let i = 0; i < board.length; i++) usedRankCount[rankOf(board[i])]++;
  let outs = 0;
  if (isHoldem) {
    const hr1 = rankOf(hand[0]);
    const hr2 = rankOf(hand[1]);
    for (let r = 2; r <= 14; r++) {
      const remain = 4 - usedRankCount[r];
      if (remain <= 0) continue;
      boardRanks.push(r);
      if (hasHoldemStraightByRankValues(hr1, hr2, boardRanks)) outs += remain;
      boardRanks.pop();
    }
  } else {
    for (let r = 2; r <= 14; r++) {
      const remain = 4 - usedRankCount[r];
      if (remain <= 0) continue;
      boardRanks.push(r);
      if (hasOmahaStraightByRankValues(hand, boardRanks)) outs += remain;
      boardRanks.pop();
    }
  }
  return outs;
}

function minOutsForSdTag(tag) {
  if (tag === "@sd") return 1;
  if (tag === "@sd12") return 12;
  if (tag === "@sd8") return 8;
  if (tag === "@sd4") return 4;
  return 4;
}

function readyTagMatch(base, plus, cls, pairRank, topBoard, isOverpair) {
  const isTopPair = cls === 1 && pairRank === topBoard;
  const isTopPairPlus = cls === 1 && pairRank >= topBoard;
  if (base === "@tp") {
    if (plus) return cls >= 2 || isTopPairPlus;
    return isTopPair;
  }
  if (base === "@overpair") {
    if (plus) return isOverpair || cls >= 2;
    return isOverpair;
  }
  if (base === "@2p") return plus ? cls >= 2 : cls === 2;
  if (base === "@set") return plus ? cls >= 3 : cls === 3;
  if (base === "@s") return plus ? cls >= 4 : cls === 4;
  if (base === "@f") return plus ? cls >= 5 : cls === 5;
  return false;
}

function pairRankFromScore(score) {
  const cls = classIdFromScore(score);
  if (cls !== 1) return 0;
  return Math.floor((score - 1_000_000) / 3375);
}

function topBoardRank(board) {
  let top = 2;
  for (let i = 0; i < board.length; i++) {
    const r = rankOf(board[i]);
    if (r > top) top = r;
  }
  return top;
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
  const hr1 = rankOf(core[0]);
  const hr2 = rankOf(core[1]);
  const boardRanks = new Array(board.length);
  for (let i = 0; i < board.length; i++) boardRanks[i] = rankOf(board[i]);
  const usedRankCount = new Uint8Array(15);
  usedRankCount[hr1]++;
  usedRankCount[hr2]++;
  for (let i = 0; i < board.length; i++) usedRankCount[rankOf(board[i])]++;
  let outs = 0;
  for (let r = 2; r <= 14; r++) {
    const remain = 4 - usedRankCount[r];
    if (remain <= 0) continue;
    boardRanks.push(r);
    const isStraight = isHoldem
      ? hasHoldemStraightByRankValues(hr1, hr2, boardRanks)
      : hasOmahaCoreStraightRanks(hr1, hr2, boardRanks);
    boardRanks.pop();
    if (isStraight) outs += remain;
  }
  return outs;
}

function coreCategoryMatch(tag, core, board, variant) {
  if (board.length < 3) return false;
  const tagInfo = splitTagToken(tag);
  if (!tagInfo) return false;
  const { base, plus } = tagInfo;
  const isHoldem = variant === "holdem";
  if (base === "@overpair" && !isHoldem) return false;

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

  if (base === "@fd") return flushDraw;

  if (base === "@sd" || base === "@sd4" || base === "@sd8" || base === "@sd12") {
    const hasStraightNow = isHoldem ? hasHoldemStraightByRanks(core, board) : hasOmahaCoreStraight(core, board);
    if (board.length >= 5 || hasStraightNow) return false;
    const outs = straightOutCountForCoreNextCard(core, board, isHoldem);
    return outs >= minOutsForSdTag(base);
  }

  const score = isHoldem ? bestHoldemScoreStreet(core, board) : bestOmahaCore2ScoreStreet(core, board);
  const cls = classIdFromScore(score);
  const topBoard = topBoardRank(board);
  const pairRank = cls === 1 ? pairRankFromScore(score) : 0;
  const isOverpair = isHoldem
    && rankOf(core[0]) === rankOf(core[1])
    && rankOf(core[0]) > topBoard;
  return readyTagMatch(base, plus, cls, pairRank, topBoard, isOverpair);
}

function variantFromHandSize(handSize) {
  if (handSize === 2) return "holdem";
  if (handSize === 4) return "plo4";
  if (handSize === 5) return "plo5";
  if (handSize === 6) return "plo6";
  return "";
}

function tagUsesSuitLabels(tagInfo) {
  return tagInfo.base === "@fd" || (tagInfo.base === "@f" && !tagInfo.plus);
}

function collectTagCoreLabels(board, variant, tagInfo) {
  const { base } = tagInfo;
  const blocked = new Uint8Array(52);
  for (const c of board) blocked[c] = 1;
  const labels = new Set();
  const useSuit = tagUsesSuitLabels(tagInfo);
  for (let c1 = 0; c1 < 52; c1++) {
    if (blocked[c1]) continue;
    for (let c2 = c1 + 1; c2 < 52; c2++) {
      if (blocked[c2]) continue;
      if (!coreCategoryMatch(tagInfo.token, [c1, c2], board, variant)) continue;
      if (useSuit || (base === "@f" && !tagInfo.plus)) labels.add(coreSuitLabel(c1, c2));
      else labels.add(coreRankLabel(c1, c2));
    }
  }
  return [...labels];
}

function tagShortcutEntry(tagInfo, board, variant) {
  const key = `${variant}|${tagInfo.token}|${board.join("-")}`;
  if (TAG_SHORTCUT_CACHE.has(key)) return TAG_SHORTCUT_CACHE.get(key);
  const labels = collectTagCoreLabels(board, variant, tagInfo);
  const out = {
    useSuit: tagUsesSuitLabels(tagInfo),
    labels: new Set(labels)
  };
  TAG_SHORTCUT_CACHE.set(key, out);
  if (TAG_SHORTCUT_CACHE.size > 5_000) TAG_SHORTCUT_CACHE.clear();
  return out;
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
  const boardRanks = new Array(board.length);
  for (let i = 0; i < board.length; i++) boardRanks[i] = rankOf(board[i]);
  const usedRankCount = new Uint8Array(15);
  for (let i = 0; i < hand.length; i++) usedRankCount[rankOf(hand[i])]++;
  for (let i = 0; i < board.length; i++) usedRankCount[rankOf(board[i])]++;
  let outs = 0;
  for (let r = 2; r <= 14; r++) {
    const remain = 4 - usedRankCount[r];
    if (remain <= 0) continue;
    boardRanks.push(r);
    if (hasOmahaStraightByRankValues(hand, boardRanks)) outs += remain;
    boardRanks.pop();
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

  const tagInfo = splitTagToken(tag);
  if (!tagInfo) return [];
  return collectTagCoreLabels(board, variant, tagInfo);
}

export function previewHoldemStraightDrawRankCombos(boardText, minOuts = 1) {
  if (minOuts <= 1) return previewTagCoreCombos(boardText, "holdem", "@sd");
  if (minOuts <= 4) return previewTagCoreCombos(boardText, "holdem", "@sd4");
  if (minOuts <= 8) return previewTagCoreCombos(boardText, "holdem", "@sd8");
  return previewTagCoreCombos(boardText, "holdem", "@sd12");
}

function categoryMatch(tag, hand, board) {
  if (board.length < 3) return false;
  const tagInfo = splitTagToken(tag);
  if (!tagInfo) return false;
  const variant = variantFromHandSize(hand.length);
  if (!variant) return false;
  const isHoldem = variant === "holdem";

  if (tagInfo.base === "@sd" || tagInfo.base === "@sd4" || tagInfo.base === "@sd8" || tagInfo.base === "@sd12") {
    if (board.length >= 5) return false;
    const hasStraightNow = isHoldem
      ? hasHoldemStraightByRanks(hand, board)
      : hasOmahaStraight(hand, board);
    if (hasStraightNow) return false;
    const outs = straightOutCountNextCard(hand, board, isHoldem);
    return outs >= minOutsForSdTag(tagInfo.base);
  }

  if (tagInfo.base === "@overpair" && variant !== "holdem") return false;
  const shortcut = tagShortcutEntry(tagInfo, board, variant);
  if (!shortcut || shortcut.labels.size === 0) return false;
  for (let a = 0; a < hand.length - 1; a++) {
    for (let b = a + 1; b < hand.length; b++) {
      const label = shortcut.useSuit
        ? coreSuitLabel(hand[a], hand[b])
        : coreRankLabel(hand[a], hand[b]);
      if (shortcut.labels.has(label)) return true;
    }
  }
  return false;
}

export function categoryMatchTag(tag, hand, board) {
  return categoryMatch(tag, hand, board);
}

