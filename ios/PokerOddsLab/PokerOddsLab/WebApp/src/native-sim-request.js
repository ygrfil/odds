import { parseCards } from "./cards.js";

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

async function playerToNativeSampler(player, handSize) {
  const range = String(player?.range || "*").trim() || "*";

  if (range.replace(/\s+/g, "") === "*") {
    return { mode: "all", hand_size: handSize };
  }

  return { mode: "range", hand_size: handSize, range_text: range };
}

export async function buildNativeSimRequest(config) {
  const variant = String(config.variant || "").trim().toLowerCase();
  const handSize = handSizeForVariant(variant);
  const board = parseCards(config.board || "");
  const dead = parseCards(config.dead || "");
  const players = Array.isArray(config.players) ? config.players : [];

  if (players.length < 2 || players.length > 6) {
    throw new Error("players must be between 2 and 6");
  }

  const nativePlayers = [];
  for (const player of players) {
    nativePlayers.push(await playerToNativeSampler(player, handSize));
  }

  const request = {
    mode: "sim",
    variant,
    iteration_cap: Math.max(1, Math.floor(Number(config.iterationCap || 100000))),
    board,
    dead,
    players: nativePlayers,
    percentile_profile: String(config.percentileProfile || "").trim().toLowerCase(),
    seed: randomSeedU64()
  };
  if (Number(config.confidenceTargetPct || 0) > 0) request.confidence_target_pct = Number(config.confidenceTargetPct);
  if (Number(config.confidenceMinIterations || 0) > 0) request.confidence_min_iters = Math.floor(Number(config.confidenceMinIterations));
  if (Number(config.confidenceLevel || 0) > 0) request.confidence_level = Number(config.confidenceLevel);
  if (Number(config.maxRuntimeMs || 0) > 0) request.max_runtime_ms = Math.floor(Number(config.maxRuntimeMs));
  return request;
}
