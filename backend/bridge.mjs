import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import {
  runSimulationRaw,
  runExhaustiveRaw,
  previewTagCoreCombos,
  previewTagCoverage,
  previewRangeCoverage,
  categoryMatchTag
} from "../src/sim-core.js";
import { cardToText, parseCards, fullDeck } from "../src/cards.js";
import { compileRange } from "../src/parser.js";
import { makeRng } from "../src/rng.js";
import { normalizePureTagToken, splitTagToken } from "../src/tag-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const NATIVE_SIM_MANIFEST = path.join(PROJECT_ROOT, "native-sim", "Cargo.toml");
const NATIVE_SIM_BIN_DEFAULT = path.join(PROJECT_ROOT, "native-sim", "target", "release", "native-sim");
const NATIVE_SIM_SOURCE_MAIN = path.join(PROJECT_ROOT, "native-sim", "src", "main.rs");
const NATIVE_SIM_BUILD_STAMP = path.join(PROJECT_ROOT, "native-sim", "target", "release", ".build-stamp.json");
const NATIVE_SIM_BUILD_STAMP_VERSION = 2;
const PLAYER_SAMPLER_CACHE = new Map();
const PLAYER_SAMPLER_CACHE_MAX = 48;
const SAMPLER_CACHE_VERSION = 2;
const SAMPLER_DISK_DIR = path.join(PROJECT_ROOT, "backend", ".cache", `samplers-v${SAMPLER_CACHE_VERSION}`);
const SAMPLER_MAX_POOL_TO_CACHE = 30_000;
const SAMPLER_MAX_FILE_BYTES = 14 * 1024 * 1024;

function variantHandSize(variant) {
  if (variant === "holdem") return 2;
  if (variant === "plo4") return 4;
  if (variant === "plo5") return 5;
  if (variant === "plo6") return 6;
  return 0;
}

function canUseExhaustive(config) {
  const need = variantHandSize(config?.variant || "");
  if (!need) return false;
  const players = Array.isArray(config?.players) ? config.players : [];
  if (players.length < 2 || players.length > 6) return false;
  for (const p of players) {
    const txt = String(p?.range || "").trim();
    if (!txt) return false;
    try {
      const cards = parseCards(txt);
      if (cards.length !== need) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function serializeRaw(raw) {
  const comboLists = (raw.comboLists || []).map((s) => Array.from(s || []));
  const comboCounts = Array.isArray(raw.comboCounts)
    ? raw.comboCounts
    : comboLists.map((arr) => arr.length);
  return {
    iterations: raw.iterations || 0,
    elapsedMs: raw.elapsedMs || 0,
    wins: raw.wins || [],
    ties: raw.ties || [],
    losses: raw.losses || [],
    equityShares: raw.equityShares || [],
    comboCounts,
    comboLists,
    classCounts: raw.classCounts || [],
    confidenceReached: !!raw.confidenceReached,
    confidenceHalfWidthPct: Number(raw.confidenceHalfWidthPct || 0),
    confidenceLevel: Number(raw.confidenceLevel || 0)
  };
}

async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeJson(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function comboKey(hand) {
  return hand.slice().sort((a, b) => a - b).join("-");
}

function hashKey(text) {
  const h = crypto.createHash("sha256");
  if (Buffer.isBuffer(text)) h.update(text);
  else h.update(String(text));
  return h.digest("hex");
}

function ensureSamplerDiskDir() {
  try {
    fs.mkdirSync(SAMPLER_DISK_DIR, { recursive: true });
  } catch {
    // ignore cache directory failures, in-memory cache still works
  }
}

function samplerCachePath(cacheKey) {
  return path.join(SAMPLER_DISK_DIR, `${hashKey(cacheKey)}.json`);
}

function isValidSamplerShape(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.mode === "all" && Number.isFinite(obj.hand_size) && obj.hand_size >= 2) return true;
  if (obj.mode !== "pool") return false;
  if (!Number.isFinite(obj.hand_size) || obj.hand_size < 2) return false;
  if (!Array.isArray(obj.pool) || obj.pool.length === 0 || obj.pool.length > SAMPLER_MAX_POOL_TO_CACHE) return false;
  for (let i = 0; i < obj.pool.length; i++) {
    const hand = obj.pool[i];
    if (!Array.isArray(hand) || hand.length !== obj.hand_size) return false;
    let prev = -1;
    for (let j = 0; j < hand.length; j++) {
      const c = hand[j];
      if (!Number.isFinite(c) || c < 0 || c > 51 || c !== Math.floor(c)) return false;
      if (c <= prev) return false;
      prev = c;
    }
  }
  return true;
}

function getCachedSampler(key) {
  if (!PLAYER_SAMPLER_CACHE.has(key)) return null;
  const value = PLAYER_SAMPLER_CACHE.get(key);
  PLAYER_SAMPLER_CACHE.delete(key);
  PLAYER_SAMPLER_CACHE.set(key, value);
  return value;
}

function putCachedSampler(key, sampler) {
  if (!key || !sampler) return;
  // Avoid caching very large pools to keep memory bounded.
  if (Array.isArray(sampler.pool) && sampler.pool.length > SAMPLER_MAX_POOL_TO_CACHE) return;
  if (!isValidSamplerShape(sampler)) return;
  if (PLAYER_SAMPLER_CACHE.has(key)) PLAYER_SAMPLER_CACHE.delete(key);
  PLAYER_SAMPLER_CACHE.set(key, sampler);
  while (PLAYER_SAMPLER_CACHE.size > PLAYER_SAMPLER_CACHE_MAX) {
    const first = PLAYER_SAMPLER_CACHE.keys().next();
    if (first?.done) break;
    PLAYER_SAMPLER_CACHE.delete(first.value);
  }

  try {
    ensureSamplerDiskDir();
    const payload = JSON.stringify({
      v: SAMPLER_CACHE_VERSION,
      key,
      createdAt: Date.now(),
      sampler
    });
    if (Buffer.byteLength(payload, "utf8") > SAMPLER_MAX_FILE_BYTES) return;
    fs.writeFileSync(samplerCachePath(key), payload, "utf8");
  } catch {
    // disk cache is best-effort
  }
}

function getCachedSamplerWithDisk(key) {
  const inMem = getCachedSampler(key);
  if (inMem) return inMem;
  try {
    const p = samplerCachePath(key);
    if (!fs.existsSync(p)) return null;
    const text = fs.readFileSync(p, "utf8");
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (!parsed || parsed.v !== SAMPLER_CACHE_VERSION || parsed.key !== key) return null;
    const sampler = parsed.sampler;
    if (!isValidSamplerShape(sampler)) return null;
    PLAYER_SAMPLER_CACHE.set(key, sampler);
    return sampler;
  } catch {
    return null;
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

function nChooseK(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let out = 1;
  for (let i = 1; i <= kk; i++) out = (out * (n - kk + i)) / i;
  return Math.round(out);
}

function enumerateRangePool(baseDeck, handSize, predicate, cap, rng) {
  const hand = new Array(handSize);
  const pool = [];
  let matched = 0;

  function rec(start, depth) {
    if (depth === handSize) {
      if (!predicate(hand)) return;
      matched++;
      const copy = hand.slice();
      if (pool.length < cap) {
        pool.push(copy);
      } else {
        const j = Math.floor(rng() * matched);
        if (j < cap) pool[j] = copy;
      }
      return;
    }
    for (let i = start; i <= baseDeck.length - (handSize - depth); i++) {
      hand[depth] = baseDeck[i];
      rec(i + 1, depth + 1);
    }
  }

  rec(0, 0);
  return { pool, matched };
}

function sampleRangePool(baseDeck, handSize, predicate, target, maxTrials, rng, maxMs = Number.POSITIVE_INFINITY) {
  const pool = [];
  const seen = new Set();
  const tmp = [];
  const started = performance.now();
  for (let i = 0; i < maxTrials; i++) {
    if ((i & 1023) === 0 && (performance.now() - started) > maxMs) break;
    if (!pickDistinct(baseDeck, handSize, rng, tmp)) break;
    if (!predicate(tmp)) continue;
    const key = comboKey(tmp);
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(tmp.slice().sort((a, b) => a - b));
    if (pool.length >= target) break;
  }
  return pool;
}

function estimateRangeAcceptance(baseDeck, handSize, predicate, rng, trials = 320) {
  const tmp = [];
  let ok = 0;
  for (let i = 0; i < trials; i++) {
    if (!pickDistinct(baseDeck, handSize, rng, tmp)) break;
    if (predicate(tmp)) ok++;
  }
  return ok / Math.max(1, trials);
}

function simpleExactIfAny(rangeText, handSize) {
  try {
    const cards = parseCards(rangeText);
    if (cards.length === handSize) return cards.slice().sort((a, b) => a - b);
  } catch {
    // not exact
  }
  return null;
}

function maybeExpandPureTagRange(rangeText, variant, boardCards) {
  const tag = normalizePureTagToken(rangeText);
  if (!tag) return rangeText;
  const tagInfo = splitTagToken(tag);
  if (!tagInfo) return rangeText;
  const holdEmExpandable = new Set([
    "@tp",
    "@tp+",
    "@overpair",
    "@overpair+",
    "@2p",
    "@2p+",
    "@set",
    "@set+",
    "@s",
    "@s+",
    "@f",
    "@f+",
    "@fd",
    "@sd",
    "@sd4",
    "@sd8",
    "@sd12"
  ]);
  const omahaExpandable = new Set(["@sd", "@sd4", "@sd8", "@sd12"]);
  if (variant === "holdem" && !holdEmExpandable.has(tagInfo.token)) return rangeText;
  if (variant !== "holdem" && !omahaExpandable.has(tagInfo.base)) return rangeText;
  if (!Array.isArray(boardCards) || boardCards.length < 3 || boardCards.length > 5) return rangeText;
  const boardText = boardCards.map((c) => cardToText(c)).join("");
  const combos = previewTagCoreCombos(boardText, variant, tagInfo.token);
  if (!Array.isArray(combos) || combos.length === 0) return rangeText;
  return combos.join(",");
}

function cardsKey(cards, ordered = true) {
  if (!Array.isArray(cards) || cards.length === 0) return "-";
  const arr = ordered ? cards.slice() : cards.slice().sort((a, b) => a - b);
  return arr.map((c) => cardToText(c)).join("");
}

function buildPlayerSampler(config, baseDeck, boardCards, deadCards, player, idx, rng) {
  const handSize = variantHandSize(config.variant);
  const rawRangeText = String(player.range || "*").trim() || "*";
  const rangeText = maybeExpandPureTagRange(rawRangeText, config.variant, boardCards);
  if (rangeText === "*") {
    return { mode: "all", hand_size: handSize };
  }

  const exact = simpleExactIfAny(rangeText, handSize);
  if (exact) {
    for (const c of exact) {
      if (!baseDeck.includes(c)) {
        throw new Error(`Player ${idx + 1} exact hand conflicts with board/dead cards.`);
      }
    }
    return { mode: "pool", hand_size: handSize, pool: [exact] };
  }

  const normalizedRange = rangeText.toLowerCase().replace(/\s+/g, "");
  const percentileProfile = String(config.percentileProfile || "").trim().toLowerCase();
  const cacheKey = [
    `v${SAMPLER_CACHE_VERSION}`,
    String(config.variant || ""),
    `b:${cardsKey(boardCards, true)}`,
    `d:${cardsKey(deadCards, false)}`,
    `h:${handSize}`,
    `pp:${percentileProfile || "-"}`,
    `r:${normalizedRange}`
  ].join("|");
  const cached = getCachedSamplerWithDisk(cacheKey);
  if (cached) return cached;

  const compiled = compileRange(rangeText, config.variant, boardCards, { percentileProfile });
  if ((compiled.weight || 0) <= 0) {
    throw new Error(`Player ${idx + 1} range appears empty on this board/dead-card setup`);
  }
  const helpers = { categoryMatch: (tag, hand, board) => categoryMatchTag(tag, hand, board) };
  const predicate = (hand) => compiled.predicate(hand, null, helpers);

  if (handSize <= 4) {
    const totalSpace = nChooseK(baseDeck.length, handSize);
    const hasTag = /@[a-z0-9_]+/i.test(rangeText);
    const hasSdTag = /@sd(?:\d+)?/i.test(rangeText);
    const acceptance = estimateRangeAcceptance(baseDeck, handSize, predicate, rng, hasTag ? 96 : 320);

    // Full 4-card enumeration is very expensive for dynamic tags like @sd.
    // In Monte Carlo mode, a large random pool is enough and much faster.
    const preferSample = handSize >= 4
      && (hasSdTag || (hasTag && totalSpace > 90_000) || acceptance >= 0.03);

    if (preferSample) {
      let target = handSize === 2 ? 12_000 : 10_000;
      let maxTrials = handSize === 2 ? 150_000 : 180_000;
      let maxMs = 700;
      if (hasSdTag) {
        target = 12_000;
        maxTrials = 180_000;
        maxMs = 500;
      } else if (hasTag) {
        target = handSize === 2 ? 8_000 : 6_000;
        maxTrials = handSize === 2 ? 100_000 : 90_000;
        maxMs = 450;
      }
      const sampled = sampleRangePool(baseDeck, handSize, predicate, target, maxTrials, rng, maxMs);
      if (sampled.length > 0) {
        const sampler = { mode: "pool", hand_size: handSize, pool: sampled };
        putCachedSampler(cacheKey, sampler);
        return sampler;
      }
      // For dynamic tag ranges, avoid expensive exact enumeration in prep path.
      if (hasTag) {
        throw new Error(`Player ${idx + 1} range appears empty on this board/dead-card setup`);
      }
      // If sample found nothing for non-tag ranges, fall back to exact enumeration.
    }

    const cap = handSize === 2 ? 15000 : 140000;
    const { pool, matched } = enumerateRangePool(baseDeck, handSize, predicate, cap, rng);
    if (!matched || pool.length === 0) {
      throw new Error(`Player ${idx + 1} range appears empty on this board/dead-card setup`);
    }
    if (matched === totalSpace) return { mode: "all", hand_size: handSize };
    const sampler = { mode: "pool", hand_size: handSize, pool };
    putCachedSampler(cacheKey, sampler);
    return sampler;
  }

  const hasTag = /@[a-z0-9_]+/i.test(rangeText);
  const hasSdTag = /@sd(?:\d+)?/i.test(rangeText);
  const totalSpace = nChooseK(baseDeck.length, handSize);
  if (!hasTag && handSize === 5) {
    // Accuracy path for PLO5 non-tag ranges:
    // Build an exact pool when range is moderate; otherwise keep a bounded uniform reservoir.
    const acceptance = estimateRangeAcceptance(baseDeck, handSize, predicate, rng, 220);
    const estimatedMatched = Math.round(totalSpace * acceptance);
    const exactCap = 320_000;
    if (estimatedMatched <= Math.round(exactCap * 1.2)) {
      const { pool, matched } = enumerateRangePool(baseDeck, handSize, predicate, exactCap, rng);
      if (!matched || pool.length === 0) {
        throw new Error(`Player ${idx + 1} range appears empty on this board/dead-card setup`);
      }
      if (matched === totalSpace) return { mode: "all", hand_size: handSize };
      const sampler = { mode: "pool", hand_size: handSize, pool };
      putCachedSampler(cacheKey, sampler);
      return sampler;
    }
  }

  let target = handSize === 5 ? 14_000 : 10_000;
  let maxTrials = handSize === 5 ? 280_000 : 320_000;
  let maxMs = 900;
  if (hasSdTag) {
    target = 9_000;
    maxTrials = 150_000;
    maxMs = 550;
  } else if (hasTag) {
    target = 7_000;
    maxTrials = 120_000;
    maxMs = 550;
  }
  const sampled = sampleRangePool(baseDeck, handSize, predicate, target, maxTrials, rng, maxMs);
  if (!sampled.length) {
    throw new Error(`Player ${idx + 1} range appears empty on this board/dead-card setup`);
  }
  const sampler = { mode: "pool", hand_size: handSize, pool: sampled };
  putCachedSampler(cacheKey, sampler);
  return sampler;
}

function prepareNativeRequest(config, req) {
  const variant = String(config.variant || "");
  const handSize = variantHandSize(variant);
  if (!handSize) throw new Error(`Unsupported variant: ${variant}`);
  const players = Array.isArray(config.players) ? config.players : [];
  if (players.length < 2 || players.length > 6) throw new Error("At least 2 and at most 6 players required.");

  const board = parseCards(String(config.board || ""));
  const dead = parseCards(String(config.dead || ""));
  const blocked = new Set(board.concat(dead));
  const baseDeck = fullDeck().filter((c) => !blocked.has(c));

  const seed = Number(req.seed || 0x9e3779b9) >>> 0;
  const rng = makeRng(seed || 1);
  const preparedPlayers = players.map((p, i) => buildPlayerSampler(config, baseDeck, board, dead, p, i, rng));

  return {
    variant,
    iteration_cap: Math.max(1, Number(config.iterationCap || req.iterCap || 100000)),
    board,
    dead,
    players: preparedPlayers,
    workers: Number.isFinite(Number(req.workers)) ? Math.max(1, Math.floor(Number(req.workers))) : undefined,
    confidence_target_pct: Number(config.confidenceTargetPct) > 0 ? Number(config.confidenceTargetPct) : undefined,
    confidence_min_iters: Number(config.confidenceMinIterations) > 0
      ? Math.max(1, Math.floor(Number(config.confidenceMinIterations)))
      : undefined,
    confidence_level: Number(config.confidenceLevel) > 0 ? Number(config.confidenceLevel) : undefined,
    seed: Number(seed || 1)
  };
}

async function runCommandWithJson(command, args, payload, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (err) {
        reject(new Error(`Invalid JSON from ${command}: ${err?.message || String(err)}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function ensureNativeBinary() {
  const forced = process.env.NATIVE_SIM_BIN ? path.resolve(process.env.NATIVE_SIM_BIN) : "";
  const candidate = forced || NATIVE_SIM_BIN_DEFAULT;
  if (forced) return fs.existsSync(candidate) ? candidate : null;

  const runCargo = async (args) => {
    await new Promise((resolve, reject) => {
      const child = spawn("cargo", args, {
        cwd: PROJECT_ROOT,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += String(d);
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `cargo ${args.join(" ")} failed`));
          return;
        }
        resolve();
      });
    });
  };

  const sourceHash = hashKey(
    [
      fs.existsSync(NATIVE_SIM_MANIFEST) ? fs.readFileSync(NATIVE_SIM_MANIFEST, "utf8") : "",
      fs.existsSync(NATIVE_SIM_SOURCE_MAIN) ? fs.readFileSync(NATIVE_SIM_SOURCE_MAIN, "utf8") : ""
    ].join("\n---\n")
  );
  if (fs.existsSync(candidate) && fs.existsSync(NATIVE_SIM_BUILD_STAMP)) {
    try {
      const stamp = JSON.parse(fs.readFileSync(NATIVE_SIM_BUILD_STAMP, "utf8"));
      const binaryHash = hashKey(fs.readFileSync(candidate));
      if (
        stamp?.version === NATIVE_SIM_BUILD_STAMP_VERSION
        && stamp?.sourceHash === sourceHash
        && stamp?.binaryHash === binaryHash
      ) return candidate;
    } catch {
      // fall through to rebuild
    }
  }
  if (!fs.existsSync(NATIVE_SIM_MANIFEST)) return null;

  // Target artifacts are tracked in this repository. A clean rebuild avoids stale fingerprint issues.
  await runCargo(["clean", "--manifest-path", NATIVE_SIM_MANIFEST]);
  await runCargo(["build", "--release", "--manifest-path", NATIVE_SIM_MANIFEST]);

  if (!fs.existsSync(candidate)) return null;
  try {
    const binaryHash = hashKey(fs.readFileSync(candidate));
    fs.mkdirSync(path.dirname(NATIVE_SIM_BUILD_STAMP), { recursive: true });
    fs.writeFileSync(NATIVE_SIM_BUILD_STAMP, JSON.stringify({
      version: NATIVE_SIM_BUILD_STAMP_VERSION,
      sourceHash,
      binaryHash,
      builtAt: Date.now()
    }), "utf8");
  } catch {
    // stamp is best-effort
  }
  return candidate;
}

function mapNativeRaw(nativeRaw) {
  return {
    iterations: nativeRaw?.iterations || 0,
    elapsedMs: nativeRaw?.elapsed_ms || 0,
    wins: nativeRaw?.wins || [],
    ties: nativeRaw?.ties || [],
    losses: nativeRaw?.losses || [],
    equityShares: nativeRaw?.equity_shares || [],
    comboCounts: nativeRaw?.combo_counts || [],
    comboLists: nativeRaw?.combo_lists || [],
    classCounts: nativeRaw?.class_counts || [],
    confidenceReached: !!nativeRaw?.confidence_reached,
    confidenceHalfWidthPct: Number(nativeRaw?.confidence_half_width_pct || 0),
    confidenceLevel: Number(nativeRaw?.confidence_level || 0)
  };
}

async function runNativeSimulation(config, req) {
  const totalStart = performance.now();
  if (canUseExhaustive(config)) {
    const raw = await runExhaustiveRaw(config, {});
    return {
      ok: true,
      mode: "exact",
      raw: serializeRaw(raw),
      timings: {
        prepareMs: 0,
        nativeMs: 0,
        totalMs: performance.now() - totalStart
      }
    };
  }

  const prepStart = performance.now();
  const payload = prepareNativeRequest(config, req);
  const prepareMs = performance.now() - prepStart;

  const nativeBin = await ensureNativeBinary();
  if (!nativeBin) throw new Error("native simulator binary not found");
  const nativeStart = performance.now();
  const resp = await runCommandWithJson(nativeBin, [], payload, PROJECT_ROOT);
  const nativeMs = performance.now() - nativeStart;
  if (!resp?.ok) throw new Error(resp?.error || "native simulator failed");
  return {
    ok: true,
    mode: "monte-native",
    raw: mapNativeRaw(resp.raw || {}),
    timings: {
      prepareMs,
      nativeMs,
      totalMs: performance.now() - totalStart
    }
  };
}

async function handleRunPart(req) {
  const config = req.config || {};
  const mode = req.mode === "auto" ? (canUseExhaustive(config) ? "exact" : "monte") : String(req.mode || "monte");
  const runner = mode === "exact" ? runExhaustiveRaw : runSimulationRaw;
  const options = {
    iterCap: req.iterCap,
    seedOverride: req.seed,
    poolScale: req.poolScale,
    partitionIndex: req.partitionIndex,
    partitionCount: req.partitionCount,
    disableStabilityStop: true
  };
  const raw = await runner(config, options);
  return { ok: true, mode, raw: serializeRaw(raw) };
}

async function main() {
  const req = await readStdinJson();
  const action = String(req.action || "");
  if (action === "health") {
    writeJson({ ok: true });
    return;
  }
  if (action === "run-part") {
    writeJson(await handleRunPart(req));
    return;
  }
  if (action === "run-native") {
    const totalStart = performance.now();
    try {
      writeJson(await runNativeSimulation(req.config || {}, req));
    } catch (nativeErr) {
      // Keep backend resilient: fallback to existing JS simulation path.
      const fallback = await handleRunPart({ ...req, mode: "auto" });
      fallback.mode = fallback.mode === "exact" ? "exact" : "monte-js-fallback";
      fallback.nativeError = nativeErr?.message || String(nativeErr);
      fallback.timings = fallback.timings || {};
      fallback.timings.totalMs = performance.now() - totalStart;
      writeJson(fallback);
    }
    return;
  }
  if (action === "preview-tag") {
    const boardText = String(req.boardText || "");
    const variant = String(req.variant || "");
    const tag = String(req.tag || "");
    const combos = previewTagCoreCombos(boardText, variant, tag);
    const coverage = previewTagCoverage(boardText, variant, tag);
    writeJson({ ok: true, combos, coverage });
    return;
  }
  if (action === "preview-range") {
    const boardText = String(req.boardText || "");
    const variant = String(req.variant || "");
    const rangeText = String(req.rangeText || "");
    const percentileProfile = String(req.percentileProfile || "").trim().toLowerCase();
    const coverage = previewRangeCoverage(boardText, variant, rangeText, { percentileProfile });
    writeJson({ ok: true, coverage });
    return;
  }
  writeJson({ ok: false, error: `Unsupported action: ${action}` });
  process.exitCode = 1;
}

main().catch((err) => {
  writeJson({ ok: false, error: err?.message || String(err) });
  process.exitCode = 1;
});
