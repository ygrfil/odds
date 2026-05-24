import { parseCards } from "./cards.js";
import { tryCompileRangeNativePlan } from "./parser.js";

function handSizeForVariant(variant) {
  if (variant === "holdem") return 2;
  if (variant === "plo4") return 4;
  if (variant === "plo5") return 5;
  if (variant === "plo6") return 6;
  throw new Error(`Unsupported variant: ${variant}`);
}

function randomSeedU64() {
  const bytes = new Uint32Array(2);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    bytes[0] = Math.floor(Math.random() * 0xffffffff);
    bytes[1] = Math.floor(Math.random() * 0xffffffff);
  }
  return ((bytes[0] & 0x1fffff) * 0x100000000) + bytes[1];
}

async function playerToNativeSampler(player, variant, handSize, board, percentileProfile) {
  const range = String(player?.range || "*").trim() || "*";
  const weightPct = rangeWeightPct(range);
  const weightField = weightPct < 100 ? { weight_pct: weightPct } : {};

  if (range.replace(/\s+/g, "") === "*") {
    return { mode: "all", hand_size: handSize, ...weightField };
  }

  const plan = tryCompileRangeNativePlan(range, variant, board, {
    percentileProfile,
    nativeExactPercentileRef: true
  });
  if (!plan) {
    throw new Error(`Range "${range}" cannot be compiled for the native iOS engine.`);
  }
  return { mode: "plan", hand_size: handSize, plan, ...weightField };
}

function rangeWeightPct(range) {
  const suffix = String(range || "").replace(/\s+/g, "").match(/@([0-9]{1,3})$/);
  if (!suffix) return 100;
  return Math.max(1, Math.min(100, Math.round(Number(suffix[1]) || 100)));
}

export async function buildNativeSimRequest(config) {
  const variant = String(config.variant || "").trim().toLowerCase();
  const handSize = handSizeForVariant(variant);
  const board = parseCards(config.board || "");
  const dead = parseCards(config.dead || "");
  const players = Array.isArray(config.players) ? config.players : [];
  const percentileProfile = String(config.percentileProfile || "").trim().toLowerCase();

  if (players.length < 2 || players.length > 6) {
    throw new Error("players must be between 2 and 6");
  }

  const nativePlayers = [];
  for (const player of players) {
    nativePlayers.push(await playerToNativeSampler(player, variant, handSize, board, percentileProfile));
  }

  const request = {
    mode: "sim",
    variant,
    iteration_cap: Math.max(1, Math.floor(Number(config.iterationCap || 100000))),
    board,
    dead,
    players: nativePlayers,
    seed: randomSeedU64()
  };
  if (Number(config.confidenceTargetPct || 0) > 0) request.confidence_target_pct = Number(config.confidenceTargetPct);
  if (Number(config.confidenceMinIterations || 0) > 0) request.confidence_min_iters = Math.floor(Number(config.confidenceMinIterations));
  if (Number(config.confidenceLevel || 0) > 0) request.confidence_level = Number(config.confidenceLevel);
  if (Number(config.maxRuntimeMs || 0) > 0) request.max_runtime_ms = Math.floor(Number(config.maxRuntimeMs));
  return request;
}
