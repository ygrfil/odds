const DRAW_TAG_BASES = Object.freeze([
  "@fd",
  "@sd",
  "@sd4",
  "@sd8",
  "@sd12"
]);

const READY_TAG_BASES = Object.freeze([
  "@tp",
  "@overpair",
  "@2p",
  "@set",
  "@s",
  "@f"
]);

const DRAW_TAG_BASE_SET = new Set(DRAW_TAG_BASES);
const READY_TAG_BASE_SET = new Set(READY_TAG_BASES);

const TAG_TOKEN_RE = /@[a-z0-9_]+\+?/gi;

function applyLegacyAlias(base, plus) {
  let outBase = base;
  let outPlus = plus;
  if (outBase === "@straight") outBase = "@s";
  else if (outBase === "@flush") outBase = "@f";
  else if (outBase === "@tpplus") {
    outBase = "@tp";
    outPlus = true;
  }
  return { base: outBase, plus: outPlus };
}

export function normalizeTagToken(rawToken) {
  const raw = String(rawToken || "").trim().toLowerCase();
  const m = raw.match(/^(@[a-z0-9_]+)(\+?)$/);
  if (!m) return "";

  let base = m[1];
  let plus = m[2] === "+";
  ({ base, plus } = applyLegacyAlias(base, plus));

  const isDraw = DRAW_TAG_BASE_SET.has(base);
  const isReady = READY_TAG_BASE_SET.has(base);
  if (!isDraw && !isReady) return "";
  if (plus && isDraw) return "";
  return `${base}${plus ? "+" : ""}`;
}

export function splitTagToken(rawToken) {
  const token = normalizeTagToken(rawToken);
  if (!token) return null;
  const plus = token.endsWith("+");
  const base = plus ? token.slice(0, -1) : token;
  return {
    token,
    base,
    plus,
    kind: READY_TAG_BASE_SET.has(base) ? "ready" : "draw"
  };
}

export function extractNormalizedTags(rangeText) {
  const rawTags = String(rangeText || "").toLowerCase().match(TAG_TOKEN_RE) || [];
  const out = [];
  for (const raw of rawTags) {
    const tag = normalizeTagToken(raw);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export function normalizePureTagToken(rangeText) {
  const token = String(rangeText || "").replace(/\s+/g, "").toLowerCase();
  return normalizeTagToken(token);
}

export function isReadyTagBase(rawTagBase) {
  const base = String(rawTagBase || "").trim().toLowerCase();
  return READY_TAG_BASE_SET.has(base);
}

export function isDrawTagBase(rawTagBase) {
  const base = String(rawTagBase || "").trim().toLowerCase();
  return DRAW_TAG_BASE_SET.has(base);
}

export { DRAW_TAG_BASES, READY_TAG_BASES };
