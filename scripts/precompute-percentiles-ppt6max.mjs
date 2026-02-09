import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = path.join(PROJECT_ROOT, "src", "percentile-tables-ppt6max.js");
const RANKS = "23456789TJQKA";
const SUIT_COUNT = 4;
const DEFAULT_BASIS = 1000;

const ORDERING_CONFIG = {
  plo4: {
    handSize: 4,
    orderingUrl: "http://www.propokertools.com/orderings/oh6maxordering.txt"
  },
  plo5: {
    handSize: 5,
    orderingUrl: "http://www.propokertools.com/orderings/oh56maxordering.txt"
  }
};

const rankToIdx = Object.fromEntries([...RANKS].map((r, i) => [r, i]));

function nChooseK(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let out = 1;
  for (let i = 1; i <= kk; i++) {
    out = (out * (n - kk + i)) / i;
  }
  return Math.round(out);
}

function buildChooseTable52(maxK) {
  const t = Array.from({ length: 53 }, () => new Int32Array(maxK + 1));
  for (let n = 0; n <= 52; n++) {
    t[n][0] = 1;
    for (let k = 1; k <= maxK; k++) {
      if (k > n) t[n][k] = 0;
      else if (k === n) t[n][k] = 1;
      else t[n][k] = t[n - 1][k - 1] + t[n - 1][k];
    }
  }
  return t;
}

const CHOOSE_52 = buildChooseTable52(6);

function comboRank52(cards) {
  const sorted = cards.slice().sort((a, b) => a - b);
  const k = sorted.length;
  let rank = 0;
  let start = 0;
  for (let i = 0; i < k; i++) {
    const ci = sorted[i];
    for (let v = start; v < ci; v++) {
      rank += CHOOSE_52[52 - (v + 1)][k - i - 1];
    }
    start = ci + 1;
  }
  return rank;
}

const suitPermutationsCache = new Map();

function suitPermutations(n) {
  if (suitPermutationsCache.has(n)) return suitPermutationsCache.get(n);
  const out = [];
  const used = new Array(SUIT_COUNT).fill(false);
  const cur = [];

  function rec(depth) {
    if (depth === n) {
      out.push(cur.slice());
      return;
    }
    for (let s = 0; s < SUIT_COUNT; s++) {
      if (used[s]) continue;
      used[s] = true;
      cur.push(s);
      rec(depth + 1);
      cur.pop();
      used[s] = false;
    }
  }

  rec(0);
  suitPermutationsCache.set(n, out);
  return out;
}

function parseOrderingLine(line, handSize) {
  const positions = [];
  let nextGroup = 0;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (ch === "(") {
      const end = line.indexOf(")", i + 1);
      if (end < 0) throw new Error(`Missing ')' in ordering line: ${line}`);
      const inside = line.slice(i + 1, end);
      if (!inside) throw new Error(`Empty suited group in ordering line: ${line}`);
      const gid = nextGroup++;
      for (const r of inside) {
        const rankIdx = rankToIdx[r];
        if (!Number.isInteger(rankIdx)) throw new Error(`Invalid rank '${r}' in ordering line: ${line}`);
        positions.push({ rankIdx, groupId: gid });
      }
      i = end + 1;
      continue;
    }

    const rankIdx = rankToIdx[ch];
    if (!Number.isInteger(rankIdx)) throw new Error(`Invalid token '${ch}' in ordering line: ${line}`);
    positions.push({ rankIdx, groupId: nextGroup++ });
    i++;
  }

  if (positions.length !== handSize) {
    throw new Error(`Expected ${handSize} cards in ordering line '${line}', got ${positions.length}`);
  }

  return positions;
}

function comboRanksFromOrderingLine(line, handSize) {
  const positions = parseOrderingLine(line, handSize);
  const distinctGroups = [...new Set(positions.map((p) => p.groupId))];
  const groupCount = distinctGroups.length;
  if (groupCount > SUIT_COUNT) {
    throw new Error(`Ordering line '${line}' requires ${groupCount} distinct suits`);
  }

  const groupToOffset = new Map(distinctGroups.map((g, i) => [g, i]));
  const perms = suitPermutations(groupCount);
  const out = new Set();

  for (const perm of perms) {
    const cards = [];
    const seen = new Set();
    let ok = true;

    for (const pos of positions) {
      const suit = perm[groupToOffset.get(pos.groupId)];
      const card = pos.rankIdx * SUIT_COUNT + suit;
      if (seen.has(card)) {
        ok = false;
        break;
      }
      seen.add(card);
      cards.push(card);
    }

    if (!ok) continue;
    out.add(comboRank52(cards));
  }

  return out;
}

function shouldSkipOrderingLine(line) {
  const skipPrefixes = [
    "A hand ordering",
    "Hands are listed",
    "Cards of",
    "For details",
    "http://",
    "Copyright",
    "Unlimited use"
  ];
  return skipPrefixes.some((p) => line.startsWith(p));
}

async function fetchOrderingLines(url) {
  const text = execFileSync("curl", ["-L", "-s", "--max-time", "60", url], {
    encoding: "utf8",
    cwd: PROJECT_ROOT,
    maxBuffer: 64 * 1024 * 1024
  });
  if (!text || !text.trim()) {
    throw new Error(`Failed to download ordering ${url}: empty response`);
  }
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line && !shouldSkipOrderingLine(line));
}

function buildSortedComboRanks(scoreKeysByComboRank, maxScore) {
  const sampleSize = scoreKeysByComboRank.length;
  const counts = new Uint32Array(maxScore + 1);
  for (let i = 0; i < sampleSize; i++) {
    const key = scoreKeysByComboRank[i];
    if (key < 1 || key > maxScore) {
      throw new Error(`Invalid score key ${key} at combo rank ${i}`);
    }
    counts[key]++;
  }

  const starts = new Uint32Array(maxScore + 1);
  let offset = 0;
  for (let score = maxScore; score >= 1; score--) {
    starts[score] = offset;
    offset += counts[score];
  }
  if (offset !== sampleSize) {
    throw new Error(`Sorted offset mismatch: ${offset} vs ${sampleSize}`);
  }

  const writeOffsets = starts.slice();
  const ordered = new Uint32Array(sampleSize);
  for (let comboRank = 0; comboRank < sampleSize; comboRank++) {
    const score = scoreKeysByComboRank[comboRank];
    const pos = writeOffsets[score]++;
    ordered[pos] = comboRank;
  }
  return ordered;
}

function buildTopBoundaries(scoreKeysByComboRank, orderedComboRanks, basis) {
  const steps = 100 * basis;
  const sampleSize = scoreKeysByComboRank.length;
  const topScoreKeys = new Int32Array(steps + 1);
  const topRanks = new Int32Array(steps + 1);
  let maxScore = 0;
  for (let i = 0; i < sampleSize; i++) {
    if (scoreKeysByComboRank[i] > maxScore) maxScore = scoreKeysByComboRank[i];
  }

  for (let idx = 0; idx <= steps; idx++) {
    const count = Math.floor((idx / steps) * sampleSize);
    if (count <= 0) {
      topScoreKeys[idx] = maxScore + 1;
      topRanks[idx] = -1;
      continue;
    }
    if (count >= sampleSize) {
      topScoreKeys[idx] = 0;
      topRanks[idx] = sampleSize - 1;
      continue;
    }

    const boundaryComboRank = orderedComboRanks[count - 1];
    topScoreKeys[idx] = scoreKeysByComboRank[boundaryComboRank];
    topRanks[idx] = boundaryComboRank;
  }

  return { topScoreKeys, topRanks };
}

function parseArgs(argv) {
  const out = {
    basis: DEFAULT_BASIS,
    variants: Object.keys(ORDERING_CONFIG),
    outFile: DEFAULT_OUT
  };

  for (const arg of argv) {
    if (arg.startsWith("--basis=")) {
      const n = Number(arg.slice("--basis=".length));
      if (Number.isFinite(n) && n > 0) out.basis = Math.max(1, Math.floor(n));
      continue;
    }
    if (arg.startsWith("--variants=")) {
      const wanted = arg
        .slice("--variants=".length)
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter((v) => ORDERING_CONFIG[v]);
      if (wanted.length) out.variants = wanted;
      continue;
    }
    if (arg.startsWith("--out=")) {
      const p = arg.slice("--out=".length).trim();
      if (p) out.outFile = path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p);
      continue;
    }
  }

  return out;
}

async function buildVariantTable(variant, cfg, basis) {
  const sampleSize = nChooseK(52, cfg.handSize);
  process.stderr.write(`[ppt6max] ${variant}: downloading ordering...\n`);
  const orderingLines = await fetchOrderingLines(cfg.orderingUrl);
  process.stderr.write(`[ppt6max] ${variant}: ${orderingLines.length.toLocaleString()} ordering lines\n`);

  const scoreKeysByComboRank = new Int32Array(sampleSize);
  let assigned = 0;

  for (let i = 0; i < orderingLines.length; i++) {
    const line = orderingLines[i];
    const scoreKey = orderingLines.length - i;
    const comboRanks = comboRanksFromOrderingLine(line, cfg.handSize);

    for (const comboRank of comboRanks) {
      if (scoreKeysByComboRank[comboRank] !== 0) {
        throw new Error(`${variant}: combo rank ${comboRank} assigned more than once (line ${i + 1}: ${line})`);
      }
      scoreKeysByComboRank[comboRank] = scoreKey;
      assigned++;
    }

    if ((i + 1) % 20000 === 0 || i + 1 === orderingLines.length) {
      process.stderr.write(
        `[ppt6max] ${variant}: ${((i + 1) / orderingLines.length * 100).toFixed(1)}% | ` +
        `${(i + 1).toLocaleString()}/${orderingLines.length.toLocaleString()} lines\n`
      );
    }
  }

  if (assigned !== sampleSize) {
    throw new Error(`${variant}: assigned combos mismatch (${assigned} vs ${sampleSize})`);
  }

  process.stderr.write(`[ppt6max] ${variant}: building sorted combo order...\n`);
  const ordered = buildSortedComboRanks(scoreKeysByComboRank, orderingLines.length);

  process.stderr.write(`[ppt6max] ${variant}: building percentile boundaries...\n`);
  const { topScoreKeys, topRanks } = buildTopBoundaries(scoreKeysByComboRank, ordered, basis);

  return {
    basis,
    sampleSize,
    source: "ppt-evolution-6max-ordering",
    generatedAt: new Date().toISOString(),
    orderingUrl: cfg.orderingUrl,
    orderingLineCount: orderingLines.length,
    scoreScale: 1,
    scoreKeysByComboRank: Array.from(scoreKeysByComboRank),
    topScoreKeys: Array.from(topScoreKeys),
    topRanks: Array.from(topRanks)
  };
}

function writeModule(outFile, tables) {
  const text =
    "// Auto-generated by scripts/precompute-percentiles-ppt6max.mjs.\n" +
    "// PPT 6-max ordering tables expanded to exact combo-level rankings.\n" +
    "// Do not edit manually.\n\n" +
    `export const PPT_6MAX_PERCENTILE_TABLES = ${JSON.stringify(tables, null, 2)};\n`;
  fs.writeFileSync(outFile, text, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outTables = {};
  for (const variant of args.variants) {
    const cfg = ORDERING_CONFIG[variant];
    if (!cfg) continue;
    outTables[variant] = await buildVariantTable(variant, cfg, args.basis);
  }
  writeModule(args.outFile, outTables);
  process.stderr.write(`[ppt6max] wrote ${args.outFile}\n`);
}

main().catch((err) => {
  process.stderr.write(`[ppt6max] error: ${err?.message || err}\n`);
  process.exit(1);
});
