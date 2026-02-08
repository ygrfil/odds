export const RANKS = "23456789TJQKA";
export const SUITS = "cdhs";

const rankToValue = Object.fromEntries([...RANKS].map((r, i) => [r, i + 2]));
const valueToRank = Object.fromEntries([...RANKS].map((r, i) => [i + 2, r]));

export function cardFromText(text) {
  const t = text.trim();
  if (t.length !== 2) return null;
  const r = t[0].toUpperCase();
  const s = t[1].toLowerCase();
  if (!RANKS.includes(r) || !SUITS.includes(s)) return null;
  return cardFromRankSuit(r, s);
}

export function cardFromRankSuit(r, s) {
  return (rankToValue[r] - 2) * 4 + SUITS.indexOf(s);
}

export function rankOf(card) {
  return Math.floor(card / 4) + 2;
}

export function suitOf(card) {
  return card % 4;
}

export function cardToText(card) {
  return `${valueToRank[rankOf(card)]}${SUITS[suitOf(card)]}`;
}

export function parseCards(raw) {
  const cleaned = raw.replace(/\s+/g, "");
  if (cleaned.length === 0) return [];
  if (cleaned.length % 2 !== 0) throw new Error(`Invalid card string: ${raw}`);
  const out = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    const c = cardFromText(cleaned.slice(i, i + 2));
    if (c == null) throw new Error(`Invalid card: ${cleaned.slice(i, i + 2)}`);
    out.push(c);
  }
  const unique = new Set(out);
  if (unique.size !== out.length) throw new Error(`Duplicate cards in: ${raw}`);
  return out;
}

export function fullDeck() {
  return Array.from({ length: 52 }, (_, i) => i);
}

export function chooseRandomDistinct(arr, n, rng) {
  if (n > arr.length) return null;
  const copy = arr.slice();
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    const t = copy[i];
    copy[i] = copy[j];
    copy[j] = t;
  }
  return copy.slice(0, n);
}

export function combinations(items, k) {
  const out = [];
  const cur = [];
  function dfs(start) {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i <= items.length - (k - cur.length); i++) {
      cur.push(items[i]);
      dfs(i + 1);
      cur.pop();
    }
  }
  dfs(0);
  return out;
}
