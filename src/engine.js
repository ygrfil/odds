import { runExhaustiveRaw, runSimulationRaw, rawToResult } from "./sim-core.js";
import { parseCards } from "./cards.js";

class BackendUnavailableError extends Error {
  constructor(message) {
    super(message || "Native backend unavailable");
    this.name = "BackendUnavailableError";
  }
}

function variantHandSize(variant) {
  if (variant === "holdem") return 2;
  if (variant === "plo4") return 4;
  if (variant === "plo5") return 5;
  if (variant === "plo6") return 6;
  return 0;
}

function canUseExhaustive(config) {
  const need = variantHandSize(config.variant);
  if (!need) return false;
  for (const p of config.players || []) {
    const txt = (p.range || "").trim();
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

function chooseWorkerCount() {
  const hw = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, hw);
}

function mergeWorkerPayloads(payloads, playerCount) {
  const wins = new Array(playerCount).fill(0);
  const ties = new Array(playerCount).fill(0);
  const losses = new Array(playerCount).fill(0);
  const equityShares = new Array(playerCount).fill(0);
  const classCounts = Array.from({ length: playerCount }, () => new Array(9).fill(0));
  const comboLists = Array.from({ length: playerCount }, () => new Set());

  let iterations = 0;
  let elapsedMs = 0;

  for (const p of payloads) {
    iterations += p.iterations;
    elapsedMs = Math.max(elapsedMs, p.elapsedMs);
    for (let i = 0; i < playerCount; i++) {
      wins[i] += p.wins[i] || 0;
      ties[i] += p.ties[i] || 0;
      losses[i] += p.losses[i] || 0;
      equityShares[i] += p.equityShares?.[i] || 0;
      for (let c = 0; c < 9; c++) classCounts[i][c] += p.classCounts?.[i]?.[c] || 0;
      const arr = p.comboLists?.[i] || [];
      for (let j = 0; j < arr.length; j++) comboLists[i].add(arr[j]);
    }
  }

  return { iterations, elapsedMs, wins, ties, losses, equityShares, classCounts, comboLists };
}

async function runWorkerGroup(config, workerCount, mode, onProgress, signal) {
  const workers = [];
  const donePayloads = [];
  const progressByWorker = new Array(workerCount).fill(0);
  let finished = 0;
  let lastEmit = 0;
  let settled = false;
  let aborted = false;
  const start = performance.now();

  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", abortHandler);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      workers.forEach((x) => x.terminate());
      reject(err);
    };

    const maybeResolve = () => {
      if (settled || finished !== workerCount) return;
      settled = true;
      cleanup();
      workers.forEach((x) => x.terminate());
      const merged = mergeWorkerPayloads(donePayloads, config.players.length);
      merged.elapsedMs = performance.now() - start;
      merged.aborted = aborted;
      resolve(merged);
    };

    const abortHandler = () => {
      aborted = true;
      workers.forEach((w) => {
        try {
          w.postMessage({ type: "stop" });
        } catch {
          // worker may already be gone
        }
      });
    };
    if (signal) signal.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) abortHandler();

    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL("./sim-worker.js", import.meta.url), { type: "module" });
      workers.push(w);

      w.onmessage = (event) => {
        const msg = event.data;
        if (!msg) return;

        if (msg.type === "progress") {
          progressByWorker[i] = msg.progress?.iterations || 0;
          const now = performance.now();
          if (now - lastEmit > 150) {
            const partial = progressByWorker.reduce((a, b) => a + b, 0);
            const elapsed = (now - start) / 1000;
            onProgress?.({
              iterations: partial,
              elapsed,
              ips: partial / Math.max(0.001, elapsed),
              boardClass: mode === "exact" ? "exhaustive" : "multi-core"
            });
            lastEmit = now;
          }
          return;
        }

        if (msg.type === "error") {
          fail(new Error(msg.error || "Worker failed"));
          return;
        }

        if (msg.type === "done") {
          donePayloads.push(msg.payload);
          finished++;
          maybeResolve();
        }
      };

      w.onerror = (err) => {
        fail(new Error(err?.message || "Worker execution failed"));
      };

      const payload = {
        type: "run",
        mode,
        workerId: i,
        config,
        seed: i * 100003 + 17
      };

      if (mode === "monte") {
        const totalIterCap = Math.max(500, Number(config.iterationCap || 100000));
        const base = Math.floor(totalIterCap / workerCount);
        const remainder = totalIterCap % workerCount;
        payload.iterCap = base + (i < remainder ? 1 : 0);
        payload.poolScale = 1 / workerCount;
      } else {
        payload.partitionIndex = i;
        payload.partitionCount = workerCount;
      }

      w.postMessage(payload);
    }
  });
}

async function runSimulationBackend(config, onProgress, signal) {
  const start = performance.now();
  let tickTimer = null;
  if (onProgress) {
    tickTimer = setInterval(() => {
      const elapsed = (performance.now() - start) / 1000;
      onProgress({
        iterations: 0,
        elapsed,
        ips: NaN,
        boardClass: "native-backend"
      });
    }, 250);
  }

  try {
    const res = await fetch("/api/sim/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
      signal
    });
    if (res.status === 404 || res.status === 405) {
      throw new BackendUnavailableError("Backend endpoint is not available.");
    }

    const contentType = String(res.headers.get("content-type") || "");
    let payload = null;
    if (contentType.includes("application/json")) {
      payload = await res.json();
    } else {
      const txt = await res.text();
      if (res.status === 404 || res.status === 405) throw new BackendUnavailableError("Backend endpoint is not available.");
      throw new Error(txt || `Backend error (${res.status})`);
    }

    if (!res.ok) throw new Error(payload?.error || `Backend error (${res.status})`);
    if (!payload?.ok || !payload?.raw) throw new Error(payload?.error || "Backend returned invalid response.");

    const raw = payload.raw;
    raw.comboLists = (raw.comboLists || []).map((arr) => new Set(arr || []));
    raw.method = payload.mode || "monte";
    const result = rawToResult(raw, { ...config, method: raw.method });
    const wallMs = performance.now() - start;
    result.backendComputeMs = Number(raw.elapsedMs || 0);
    result.elapsedMs = wallMs;
    result.timings = {
      prepareMs: Number(payload?.timings?.prepareMs || 0),
      nativeMs: Number(payload?.timings?.nativeMs || 0),
      totalMs: Number(payload?.timings?.totalMs || 0),
      wallMs
    };
    result.backend = true;
    return result;
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    if (err instanceof BackendUnavailableError) throw err;
    if (err instanceof TypeError) throw new BackendUnavailableError(err.message || "Native backend unavailable");
    throw err;
  } finally {
    if (tickTimer) clearInterval(tickTimer);
  }
}

export async function runSimulation(config, onProgress, signal) {
  const canTryBackend = typeof window !== "undefined"
    && typeof fetch !== "undefined"
    && String(window.location.protocol || "").startsWith("http");
  if (canTryBackend) {
    try {
      return await runSimulationBackend(config, onProgress, signal);
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      if (!(err instanceof BackendUnavailableError)) throw err;
      // Fallback to browser mode when backend is not running.
    }
  }

  const method = canUseExhaustive(config) ? "exact" : "monte";
  const effectiveConfig = { ...config, method };
  const workersAvailable = typeof Worker !== "undefined";
  const workerCount = chooseWorkerCount();

  let raw;
  if (workersAvailable && workerCount > 1) {
    raw = await runWorkerGroup(effectiveConfig, workerCount, method, onProgress, signal);
    if (!raw) {
      raw = {
        iterations: 0,
        elapsedMs: 0,
        wins: effectiveConfig.players.map(() => 0),
        ties: effectiveConfig.players.map(() => 0),
        losses: effectiveConfig.players.map(() => 0),
        equityShares: effectiveConfig.players.map(() => 0),
        classCounts: effectiveConfig.players.map(() => new Array(9).fill(0)),
        comboLists: effectiveConfig.players.map(() => new Set())
      };
    }
  } else {
    const runner = method === "exact" ? runExhaustiveRaw : runSimulationRaw;
    raw = await runner(effectiveConfig, { onProgress, signal });
  }
  raw.method = method;
  return rawToResult(raw, effectiveConfig);
}
