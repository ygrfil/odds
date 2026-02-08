import { rankOf, suitOf } from "./cards.js";

export const CLASS_NAMES = [
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

const HOLD_COMBOS = [
  [0, 1, 2, 3, 4], [0, 1, 2, 3, 5], [0, 1, 2, 3, 6], [0, 1, 2, 4, 5], [0, 1, 2, 4, 6],
  [0, 1, 2, 5, 6], [0, 1, 3, 4, 5], [0, 1, 3, 4, 6], [0, 1, 3, 5, 6], [0, 1, 4, 5, 6],
  [0, 2, 3, 4, 5], [0, 2, 3, 4, 6], [0, 2, 3, 5, 6], [0, 2, 4, 5, 6], [0, 3, 4, 5, 6],
  [1, 2, 3, 4, 5], [1, 2, 3, 4, 6], [1, 2, 3, 5, 6], [1, 2, 4, 5, 6], [1, 3, 4, 5, 6],
  [2, 3, 4, 5, 6]
];

const BOARD_3_COMBOS = [
  [0, 1, 2], [0, 1, 3], [0, 1, 4], [0, 2, 3], [0, 2, 4],
  [0, 3, 4], [1, 2, 3], [1, 2, 4], [1, 3, 4], [2, 3, 4]
];

function chooseCombos(n, k) {
  const out = [];
  const cur = [];
  function dfs(start) {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i <= n - (k - cur.length); i++) {
      cur.push(i);
      dfs(i + 1);
      cur.pop();
    }
  }
  dfs(0);
  return out;
}

const HOLD_STREET_COMBOS = {
  5: [[0, 1, 2, 3, 4]],
  6: chooseCombos(6, 5),
  7: HOLD_COMBOS
};

const BOARD_STREET_COMBOS = {
  3: [[0, 1, 2]],
  4: chooseCombos(4, 3),
  5: BOARD_3_COMBOS
};

const OMAHA_HOLE_2 = {
  4: [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]],
  5: [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]],
  6: [
    [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5],
    [2, 3], [2, 4], [2, 5], [3, 4], [3, 5], [4, 5]
  ]
};

function encode5(a, b, c, d, e) {
  return (((((a * 15) + b) * 15 + c) * 15 + d) * 15) + e;
}

function encode3(a, b, c) {
  return ((a * 15) + b) * 15 + c;
}

function evaluate5Score(c1, c2, c3, c4, c5) {
  const r1 = rankOf(c1); const r2 = rankOf(c2); const r3 = rankOf(c3); const r4 = rankOf(c4); const r5 = rankOf(c5);
  const s1 = suitOf(c1); const s2 = suitOf(c2); const s3 = suitOf(c3); const s4 = suitOf(c4); const s5 = suitOf(c5);

  const flush = (s1 === s2 && s2 === s3 && s3 === s4 && s4 === s5);

  const cnt = new Uint8Array(15);
  cnt[r1]++; cnt[r2]++; cnt[r3]++; cnt[r4]++; cnt[r5]++;

  const sorted = [r1, r2, r3, r4, r5].sort((a, b) => b - a);

  let unique = 0;
  for (let r = 2; r <= 14; r++) if (cnt[r]) unique++;

  let straightHigh = 0;
  if (unique === 5) {
    if (sorted[0] - sorted[4] === 4) straightHigh = sorted[0];
    else if (cnt[14] && cnt[5] && cnt[4] && cnt[3] && cnt[2]) straightHigh = 5;
  }

  let g1c = 0, g1r = 0, g2c = 0, g2r = 0;
  const singles = [];
  for (let r = 14; r >= 2; r--) {
    const c = cnt[r];
    if (!c) continue;
    if (c > g1c || (c === g1c && r > g1r)) {
      g2c = g1c; g2r = g1r;
      g1c = c; g1r = r;
    } else if (c > g2c || (c === g2c && r > g2r)) {
      g2c = c; g2r = r;
    }
    if (c === 1) singles.push(r);
  }

  if (flush && straightHigh) return 8_000_000 + straightHigh;
  if (g1c === 4) return 7_000_000 + g1r * 15 + g2r;
  if (g1c === 3 && g2c === 2) return 6_000_000 + g1r * 15 + g2r;
  if (flush) return 5_000_000 + encode5(sorted[0], sorted[1], sorted[2], sorted[3], sorted[4]);
  if (straightHigh) return 4_000_000 + straightHigh;
  if (g1c === 3) return 3_000_000 + g1r * 225 + singles[0] * 15 + singles[1];
  if (g1c === 2 && g2c === 2) {
    const hi = Math.max(g1r, g2r);
    const lo = Math.min(g1r, g2r);
    let kicker = 0;
    for (let r = 14; r >= 2; r--) {
      if (cnt[r] === 1) {
        kicker = r;
        break;
      }
    }
    return 2_000_000 + hi * 225 + lo * 15 + kicker;
  }
  if (g1c === 2) return 1_000_000 + g1r * 3375 + encode3(singles[0], singles[1], singles[2]);
  return encode5(sorted[0], sorted[1], sorted[2], sorted[3], sorted[4]);
}

export function classIdFromScore(score) {
  return Math.floor(score / 1_000_000);
}

export function bestHoldemScore(hole, board5) {
  return bestHoldemScoreStreet(hole, board5);
}

export function bestHoldemScoreStreet(hole, boardCards) {
  const all = hole.concat(boardCards);
  const combos = HOLD_STREET_COMBOS[all.length];
  if (!combos) throw new Error("Hold'em street evaluation requires 5-7 total cards.");
  let best = 0;
  for (let i = 0; i < combos.length; i++) {
    const c = combos[i];
    const sc = evaluate5Score(all[c[0]], all[c[1]], all[c[2]], all[c[3]], all[c[4]]);
    if (sc > best) best = sc;
  }
  return best;
}

export function bestOmahaScore(hole, board5) {
  return bestOmahaScoreStreet(hole, board5);
}

export function bestOmahaScoreStreet(hole, boardCards) {
  const bCombos = BOARD_STREET_COMBOS[boardCards.length];
  if (!bCombos) throw new Error("Omaha street evaluation requires board with 3-5 cards.");
  const hCombos = OMAHA_HOLE_2[hole.length];
  if (!hCombos) throw new Error("Omaha hand must be 4, 5, or 6 cards.");
  let best = 0;
  for (let i = 0; i < hCombos.length; i++) {
    const hc = hCombos[i];
    const h1 = hole[hc[0]];
    const h2 = hole[hc[1]];
    for (let j = 0; j < bCombos.length; j++) {
      const bc = bCombos[j];
      const sc = evaluate5Score(h1, h2, boardCards[bc[0]], boardCards[bc[1]], boardCards[bc[2]]);
      if (sc > best) best = sc;
    }
  }
  return best;
}

export function bestOmahaCore2ScoreStreet(core2, boardCards) {
  if (!Array.isArray(core2) || core2.length !== 2) throw new Error("Omaha core evaluation requires exactly 2 hole cards.");
  const bCombos = BOARD_STREET_COMBOS[boardCards.length];
  if (!bCombos) throw new Error("Omaha street evaluation requires board with 3-5 cards.");
  let best = 0;
  const h1 = core2[0];
  const h2 = core2[1];
  for (let j = 0; j < bCombos.length; j++) {
    const bc = bCombos[j];
    const sc = evaluate5Score(h1, h2, boardCards[bc[0]], boardCards[bc[1]], boardCards[bc[2]]);
    if (sc > best) best = sc;
  }
  return best;
}

export function classNameFromScore(score) {
  return CLASS_NAMES[Math.floor(score / 1_000_000)] || "High Card";
}

export function classifyBoard(boardCards) {
  if (boardCards.length < 3) return "N/A";
  const ranks = boardCards.map(rankOf);
  const suits = boardCards.map(suitOf);
  const uniqueRanks = new Set(ranks).size;
  const suitCounts = [0, 0, 0, 0];
  for (const s of suits) suitCounts[s]++;
  const maxSuit = Math.max(...suitCounts);
  const monotoneFlop = suits[0] === suits[1] && suits[1] === suits[2];
  const pairState = uniqueRanks === boardCards.length ? "Unpaired" : uniqueRanks === boardCards.length - 1 ? "Paired" : "Trips+";
  if (monotoneFlop) return `${pairState}, Monotone flop`;
  if (maxSuit >= 3) return `${pairState}, 3+ same suit`;
  return `${pairState}, Rainbow/Mixed`;
}

export function boardDrawInfo(hole, board) {
  if (board.length < 3) {
    return { flushDraw: false, madeFlush: false, twoPairOrBetter: false, set: false };
  }
  const boardSuits = [0, 0, 0, 0];
  for (const c of board) boardSuits[suitOf(c)]++;
  const holeSuits = [0, 0, 0, 0];
  for (const c of hole) holeSuits[suitOf(c)]++;
  let fd = false;
  let flush = false;
  for (let s = 0; s < 4; s++) {
    const total = boardSuits[s] + holeSuits[s];
    if (total >= 5) flush = true;
    if (boardSuits[s] >= 2 && total >= 4) fd = true;
  }

  const cnt = new Uint8Array(15);
  for (const c of hole) cnt[rankOf(c)]++;
  for (const c of board) cnt[rankOf(c)]++;

  let top = 0;
  let second = 0;
  for (let r = 2; r <= 14; r++) {
    const c = cnt[r];
    if (c > top) {
      second = top;
      top = c;
    } else if (c > second) {
      second = c;
    }
  }
  const set = top >= 3;
  const twoPairOrBetter = (top >= 2 && second >= 2) || top >= 3;
  return { flushDraw: fd, madeFlush: flush, twoPairOrBetter, set };
}
