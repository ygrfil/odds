import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createInterface } from "node:readline";
import {
  runSimulationRaw,
  runExhaustiveRaw,
  previewTagCoreCombos,
  previewTagCoverage,
  previewRangeCoverage,
  categoryMatchTag
} from "../src/sim-core.js";
import { cardToText, parseCards, fullDeck } from "../src/cards.js";
import { compileRange, tryCompileRangeNativePlan } from "../src/parser.js";
import { makeRng } from "../src/rng.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const NATIVE_SIM_MANIFEST = path.join(PROJECT_ROOT, "native-sim", "Cargo.toml");
const NATIVE_SIM_BIN_DEFAULT = path.join(PROJECT_ROOT, "native-sim", "target", "release", "native-sim");
const NATIVE_SIM_SOURCE_MAIN = path.join(PROJECT_ROOT, "native-sim", "src", "main.rs");
const NATIVE_SIM_BUILD_STAMP = path.join(PROJECT_ROOT, "native-sim", "target", "release", ".build-stamp.json");
const NATIVE_SIM_BUILD_STAMP_VERSION = 2;
const PLAYER_SAMPLER_CACHE = new Map();
const PLAYER_SAMPLER_CACHE_MAX = 48;
const SAMPLER_CACHE_VERSION = 3;
const SAMPLER_DISK_DIR = path.join(PROJECT_ROOT, "backend", ".cache", `samplers-v${SAMPLER_CACHE_VERSION}`);
const SAMPLER_MAX_POOL_TO_CACHE_MEM = 30_000;
const SAMPLER_MAX_POOL_TO_CACHE_DISK = 220_000;
const SAMPLER_MAX_FILE_BYTES = 64 * 1024 * 1024;

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
  process.stdout.write(`${JSON.stringify(obj)}\n`);
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
  if (!Array.isArray(obj.pool) || obj.pool.length === 0 || obj.pool.length > SAMPLER_MAX_POOL_TO_CACHE_DISK) return false;
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
  if (!isValidSamplerShape(sampler)) return;

  const poolLen = Array.isArray(sampler.pool) ? sampler.pool.length : 0;
  const allowMem = poolLen === 0 || poolLen <= SAMPLER_MAX_POOL_TO_CACHE_MEM;
  const allowDisk = poolLen === 0 || poolLen <= SAMPLER_MAX_POOL_TO_CACHE_DISK;

  if (allowMem) {
    if (PLAYER_SAMPLER_CACHE.has(key)) PLAYER_SAMPLER_CACHE.delete(key);
    PLAYER_SAMPLER_CACHE.set(key, sampler);
    while (PLAYER_SAMPLER_CACHE.size > PLAYER_SAMPLER_CACHE_MAX) {
      const first = PLAYER_SAMPLER_CACHE.keys().next();
      if (first?.done) break;
      PLAYER_SAMPLER_CACHE.delete(first.value);
    }
  }

  if (!allowDisk) return;
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
    const poolLen = Array.isArray(sampler.pool) ? sampler.pool.length : 0;
    if (poolLen === 0 || poolLen <= SAMPLER_MAX_POOL_TO_CACHE_MEM) {
      if (PLAYER_SAMPLER_CACHE.has(key)) PLAYER_SAMPLER_CACHE.delete(key);
      PLAYER_SAMPLER_CACHE.set(key, sampler);
      while (PLAYER_SAMPLER_CACHE.size > PLAYER_SAMPLER_CACHE_MAX) {
        const first = PLAYER_SAMPLER_CACHE.keys().next();
        if (first?.done) break;
        PLAYER_SAMPLER_CACHE.delete(first.value);
      }
    }
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

function maybeExpandPureTagRange(rangeText, _variant, _boardCards) {
  return rangeText;
}

function cardsKey(cards, ordered = true) {
  if (!Array.isArray(cards) || cards.length === 0) return "-";
  const arr = ordered ? cards.slice() : cards.slice().sort((a, b) => a - b);
  return arr.map((c) => cardToText(c)).join("");
}

function exactCoverageHint(config, playerIndex, totalSpace) {
  const entries = Array.isArray(config?.rangeCoverage) ? config.rangeCoverage : null;
  if (!entries || playerIndex < 0 || playerIndex >= entries.length) return null;
  const cov = entries[playerIndex];
  if (!cov || typeof cov !== "object" || cov.approx) return null;
  const matchedNum = Number(cov.matched);
  const totalNum = Number(cov.total);
  if (!Number.isFinite(matchedNum) || !Number.isFinite(totalNum) || totalNum <= 0) return null;
  const totalRounded = Math.round(totalNum);
  const spaceRounded = Math.round(Number(totalSpace) || 0);
  if (totalRounded <= 0 || spaceRounded <= 0 || totalRounded !== spaceRounded) return null;
  const matched = Math.max(0, Math.min(totalRounded, Math.round(matchedNum)));
  return {
    matched,
    total: totalRounded,
    acceptance: matched / totalRounded
  };
}

async function buildPlayerSampler(
  config,
  baseDeck,
  boardCards,
  deadCards,
  player,
  idx,
  rng,
  requestSamplerCache = null,
  nativeBin = ""
) {
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
  if (requestSamplerCache?.has(cacheKey)) return requestSamplerCache.get(cacheKey);
  const cached = getCachedSamplerWithDisk(cacheKey);
  if (cached) {
    requestSamplerCache?.set(cacheKey, cached);
    return cached;
  }

  const compiled = compileRange(rangeText, config.variant, boardCards, { percentileProfile });
  if ((compiled.weight || 0) <= 0) {
    throw new Error(`Player ${idx + 1} range appears empty on this board/dead-card setup`);
  }
  const helpers = { categoryMatch: (tag, hand, board) => categoryMatchTag(tag, hand, board) };
  const predicate = (hand) => compiled.predicate(hand, null, helpers);
  const totalSpace = nChooseK(baseDeck.length, handSize);
  const covHint = exactCoverageHint(config, idx, totalSpace);
  if (covHint) {
    if (covHint.matched <= 0) {
      throw new Error(`Player ${idx + 1} range appears empty on this board/dead-card setup`);
    }
    if (covHint.matched >= totalSpace) {
      return { mode: "all", hand_size: handSize };
    }
  }

  const hasTag = /@[a-z0-9_]+/i.test(rangeText);
  const nativePlan = (!hasTag && nativeBin)
    ? tryCompileRangeNativePlan(rangeText, config.variant, boardCards, { percentileProfile })
    : null;
  const buildPoolViaNative = async (cap) => {
    if (!nativeBin || !nativePlan) return null;
    try {
      const seed = Math.max(1, Math.floor(rng() * 0xffff_ffff)) >>> 0;
      const payload = {
        mode: "build-pool",
        variant: String(config.variant || ""),
        iteration_cap: 1,
        board: boardCards,
        dead: deadCards,
        hand_size: handSize,
        pool_cap: Math.max(1, Math.floor(Number(cap) || 1)),
        seed,
        plan: nativePlan
      };
      const resp = await runCommandWithJson(nativeBin, [], payload, PROJECT_ROOT);
      if (!resp?.ok || !resp?.pool_build) return null;
      const built = resp.pool_build;
      const pool = Array.isArray(built.pool) ? built.pool : [];
      const matched = Math.max(0, Math.floor(Number(built.matched) || 0));
      if (!pool.length || matched <= 0) return null;
      return { pool, matched };
    } catch {
      return null;
    }
  };

  if (handSize <= 4) {
    const hasSdTag = /@sd(?:\d+)?/i.test(rangeText);
    const acceptance = covHint
      ? covHint.acceptance
      : estimateRangeAcceptance(baseDeck, handSize, predicate, rng, hasTag ? 96 : 320);

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
        requestSamplerCache?.set(cacheKey, sampler);
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
    const nativeBuilt = await buildPoolViaNative(cap);
    const enumerated = nativeBuilt || enumerateRangePool(baseDeck, handSize, predicate, cap, rng);
    const { pool, matched } = enumerated;
    if (!matched || pool.length === 0) {
      throw new Error(`Player ${idx + 1} range appears empty on this board/dead-card setup`);
    }
    if (matched === totalSpace) return { mode: "all", hand_size: handSize };
    const sampler = { mode: "pool", hand_size: handSize, pool };
    requestSamplerCache?.set(cacheKey, sampler);
    putCachedSampler(cacheKey, sampler);
    return sampler;
  }

  const hasSdTag = /@sd(?:\d+)?/i.test(rangeText);
  if (!hasTag && handSize === 5) {
    // Accuracy path for PLO5 non-tag ranges:
    // Build an exact pool when range is moderate; otherwise keep a bounded uniform reservoir.
    const acceptance = covHint
      ? covHint.acceptance
      : estimateRangeAcceptance(baseDeck, handSize, predicate, rng, 220);
    const estimatedMatched = Math.round(totalSpace * acceptance);
    const exactCap = 320_000;
    if (estimatedMatched <= Math.round(exactCap * 1.2)) {
      const nativeBuilt = await buildPoolViaNative(exactCap);
      const enumerated = nativeBuilt || enumerateRangePool(baseDeck, handSize, predicate, exactCap, rng);
      const { pool, matched } = enumerated;
      if (!matched || pool.length === 0) {
        throw new Error(`Player ${idx + 1} range appears empty on this board/dead-card setup`);
      }
      if (matched === totalSpace) return { mode: "all", hand_size: handSize };
      const sampler = { mode: "pool", hand_size: handSize, pool };
      requestSamplerCache?.set(cacheKey, sampler);
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
  requestSamplerCache?.set(cacheKey, sampler);
  putCachedSampler(cacheKey, sampler);
  return sampler;
}

async function prepareNativeRequest(config, req, nativeBin = "") {
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
  const requestSamplerCache = new Map();
  const preparedPlayers = [];
  const preparePlayersMs = [];
  for (let i = 0; i < players.length; i++) {
    const playerStart = performance.now();
    preparedPlayers.push(
      await buildPlayerSampler(config, baseDeck, board, dead, players[i], i, rng, requestSamplerCache, nativeBin)
    );
    preparePlayersMs.push(performance.now() - playerStart);
  }

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
    seed: Number(seed || 1),
    _timing_preparePlayersMs: preparePlayersMs
  };
}

async function runCommandWithJsonDetailed(command, args, payload, cwd) {
  const start = performance.now();
  const payloadStart = performance.now();
  const payloadText = JSON.stringify(payload);
  const payloadMs = performance.now() - payloadStart;
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
      const parseStart = performance.now();
      try {
        const json = JSON.parse(stdout || "{}");
        const parseMs = performance.now() - parseStart;
        resolve({
          json,
          timing: {
            totalMs: performance.now() - start,
            payloadMs,
            processMs: Math.max(0, performance.now() - start - payloadMs - parseMs),
            parseMs,
            stdinBytes: Buffer.byteLength(payloadText, "utf8"),
            stdoutBytes: Buffer.byteLength(stdout, "utf8")
          }
        });
      } catch (err) {
        reject(new Error(`Invalid JSON from ${command}: ${err?.message || String(err)}`));
      }
    });
    child.stdin.end(payloadText);
  });
}

async function runCommandWithJson(command, args, payload, cwd) {
  const out = await runCommandWithJsonDetailed(command, args, payload, cwd);
  return out.json;
}

async function ensureNativeBinary(timingOut = null) {
  const started = performance.now();
  const timing = {
    totalMs: 0,
    forced: false,
    forcedExists: false,
    sourceHashMs: 0,
    stampCheckMs: 0,
    cacheHit: false,
    rebuilt: false,
    cargoCleanMs: 0,
    cargoBuildMs: 0,
    stampWriteMs: 0
  };
  const finish = (binPath) => {
    timing.totalMs = performance.now() - started;
    if (timingOut && typeof timingOut === "object") Object.assign(timingOut, timing);
    return binPath;
  };

  const forced = process.env.NATIVE_SIM_BIN ? path.resolve(process.env.NATIVE_SIM_BIN) : "";
  const candidate = forced || NATIVE_SIM_BIN_DEFAULT;
  if (forced) {
    timing.forced = true;
    timing.forcedExists = fs.existsSync(candidate);
    return finish(timing.forcedExists ? candidate : null);
  }

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

  const sourceHashStart = performance.now();
  const sourceHash = hashKey(
    [
      fs.existsSync(NATIVE_SIM_MANIFEST) ? fs.readFileSync(NATIVE_SIM_MANIFEST, "utf8") : "",
      fs.existsSync(NATIVE_SIM_SOURCE_MAIN) ? fs.readFileSync(NATIVE_SIM_SOURCE_MAIN, "utf8") : ""
    ].join("\n---\n")
  );
  timing.sourceHashMs = performance.now() - sourceHashStart;
  if (fs.existsSync(candidate) && fs.existsSync(NATIVE_SIM_BUILD_STAMP)) {
    const stampStart = performance.now();
    try {
      const stamp = JSON.parse(fs.readFileSync(NATIVE_SIM_BUILD_STAMP, "utf8"));
      const binaryHash = hashKey(fs.readFileSync(candidate));
      if (
        stamp?.version === NATIVE_SIM_BUILD_STAMP_VERSION
        && stamp?.sourceHash === sourceHash
        && stamp?.binaryHash === binaryHash
      ) {
        timing.cacheHit = true;
        timing.stampCheckMs = performance.now() - stampStart;
        return finish(candidate);
      }
    } catch {
      // fall through to rebuild
    }
    timing.stampCheckMs = performance.now() - stampStart;
  }
  if (!fs.existsSync(NATIVE_SIM_MANIFEST)) return finish(null);

  // Target artifacts are tracked in this repository. A clean rebuild avoids stale fingerprint issues.
  const cargoCleanStart = performance.now();
  await runCargo(["clean", "--manifest-path", NATIVE_SIM_MANIFEST]);
  timing.cargoCleanMs = performance.now() - cargoCleanStart;
  const cargoBuildStart = performance.now();
  await runCargo(["build", "--release", "--manifest-path", NATIVE_SIM_MANIFEST]);
  timing.cargoBuildMs = performance.now() - cargoBuildStart;
  timing.rebuilt = true;

  if (!fs.existsSync(candidate)) return finish(null);
  try {
    const stampWriteStart = performance.now();
    const binaryHash = hashKey(fs.readFileSync(candidate));
    fs.mkdirSync(path.dirname(NATIVE_SIM_BUILD_STAMP), { recursive: true });
    fs.writeFileSync(NATIVE_SIM_BUILD_STAMP, JSON.stringify({
      version: NATIVE_SIM_BUILD_STAMP_VERSION,
      sourceHash,
      binaryHash,
      builtAt: Date.now()
    }), "utf8");
    timing.stampWriteMs = performance.now() - stampWriteStart;
  } catch {
    // stamp is best-effort
  }
  return finish(candidate);
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

async function tryPreviewRangeCoverageNative(boardText, variant, rangeText, percentileProfile) {
  const handSize = variantHandSize(variant);
  if (!handSize) return null;
  const board = parseCards(String(boardText || ""));
  if (board.length > 5) return null;

  const plan = tryCompileRangeNativePlan(rangeText, variant, board, { percentileProfile });
  if (!plan) return null;

  const nativeBin = await ensureNativeBinary();
  if (!nativeBin) return null;

  const payload = {
    mode: "build-pool",
    variant,
    iteration_cap: 1,
    board,
    dead: [],
    hand_size: handSize,
    pool_cap: 1,
    seed: 1,
    plan
  };

  const resp = await runCommandWithJson(nativeBin, [], payload, PROJECT_ROOT);
  if (!resp?.ok || !resp?.pool_build) return null;
  const total = Math.max(0, Math.floor(Number(resp.pool_build.total) || 0));
  const matched = Math.max(0, Math.floor(Number(resp.pool_build.matched) || 0));
  return {
    matched,
    total,
    pct: total > 0 ? (matched * 100) / total : 0,
    approx: false
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

  const ensureTiming = {};
  const nativeBin = await ensureNativeBinary(ensureTiming);
  if (!nativeBin) throw new Error("native simulator binary not found");

  const prepStart = performance.now();
  const payload = await prepareNativeRequest(config, req, nativeBin);
  const prepareMs = performance.now() - prepStart;
  const preparePlayersMs = Array.isArray(payload?._timing_preparePlayersMs)
    ? payload._timing_preparePlayersMs.map((v) => Number(v || 0))
    : [];
  delete payload._timing_preparePlayersMs;
  const nativeStart = performance.now();
  const nativeCall = await runCommandWithJsonDetailed(nativeBin, [], payload, PROJECT_ROOT);
  const resp = nativeCall.json;
  const nativeMs = performance.now() - nativeStart;
  if (!resp?.ok) throw new Error(resp?.error || "native simulator failed");
  return {
    ok: true,
    mode: "monte-native",
    raw: mapNativeRaw(resp.raw || {}),
    timings: {
      prepareMs,
      nativeMs,
      totalMs: performance.now() - totalStart,
      preparePlayersMs,
      ensureMs: Number(ensureTiming.totalMs || 0),
      ensureSourceHashMs: Number(ensureTiming.sourceHashMs || 0),
      ensureStampCheckMs: Number(ensureTiming.stampCheckMs || 0),
      ensureCargoCleanMs: Number(ensureTiming.cargoCleanMs || 0),
      ensureCargoBuildMs: Number(ensureTiming.cargoBuildMs || 0),
      ensureStampWriteMs: Number(ensureTiming.stampWriteMs || 0),
      ensureCacheHit: !!ensureTiming.cacheHit,
      ensureRebuilt: !!ensureTiming.rebuilt,
      nativeCommandMs: Number(nativeCall?.timing?.totalMs || 0),
      nativeCommandPayloadMs: Number(nativeCall?.timing?.payloadMs || 0),
      nativeCommandProcessMs: Number(nativeCall?.timing?.processMs || 0),
      nativeCommandParseMs: Number(nativeCall?.timing?.parseMs || 0),
      nativeCommandStdinBytes: Number(nativeCall?.timing?.stdinBytes || 0),
      nativeCommandStdoutBytes: Number(nativeCall?.timing?.stdoutBytes || 0)
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

async function handleRequest(req) {
  const action = String(req.action || "");
  if (action === "health") {
    return { ok: true };
  }
  if (action === "run-part") {
    return await handleRunPart(req);
  }
  if (action === "run-native") {
    const totalStart = performance.now();
    try {
      return await runNativeSimulation(req.config || {}, req);
    } catch (nativeErr) {
      // Keep backend resilient: fallback to existing JS simulation path.
      const fallback = await handleRunPart({ ...req, mode: "auto" });
      fallback.mode = fallback.mode === "exact" ? "exact" : "monte-js-fallback";
      fallback.nativeError = nativeErr?.message || String(nativeErr);
      fallback.timings = fallback.timings || {};
      fallback.timings.totalMs = performance.now() - totalStart;
      return fallback;
    }
  }
  if (action === "preview-tag") {
    const boardText = String(req.boardText || "");
    const variant = String(req.variant || "");
    const tag = String(req.tag || "");
    const combos = previewTagCoreCombos(boardText, variant, tag);
    const coverage = previewTagCoverage(boardText, variant, tag);
    return { ok: true, combos, coverage };
  }
  if (action === "preview-range") {
    const boardText = String(req.boardText || "");
    const variant = String(req.variant || "");
    const rangeText = String(req.rangeText || "");
    const percentileProfile = String(req.percentileProfile || "").trim().toLowerCase();
    let coverage = null;
    try {
      coverage = await tryPreviewRangeCoverageNative(boardText, variant, rangeText, percentileProfile);
    } catch {
      coverage = null;
    }
    if (!coverage) coverage = previewRangeCoverage(boardText, variant, rangeText, { percentileProfile });
    return { ok: true, coverage };
  }
  return { ok: false, error: `Unsupported action: ${action}` };
}

async function oneShotMain() {
  const req = await readStdinJson();
  const out = await handleRequest(req);
  writeJson(out);
  if (!out?.ok) process.exitCode = 1;
}

async function daemonMain() {
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false
  });
  for await (const line of rl) {
    const text = String(line || "").trim();
    if (!text) continue;
    let req = {};
    try {
      req = JSON.parse(text);
    } catch (err) {
      writeJson({ ok: false, error: `invalid json: ${err?.message || String(err)}` });
      continue;
    }
    try {
      writeJson(await handleRequest(req));
    } catch (err) {
      writeJson({ ok: false, error: err?.message || String(err) });
    }
  }
}

const mainPromise = process.env.BRIDGE_DAEMON === "1" ? daemonMain() : oneShotMain();
mainPromise.catch((err) => {
  writeJson({ ok: false, error: err?.message || String(err) });
  process.exitCode = 1;
});
