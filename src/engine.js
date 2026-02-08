import { runSimulationRaw, rawToResult } from "./sim-core.js";

function chooseWorkerCount(config) {
  const requested = config.workers;
  const hw = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  const auto = Math.max(1, Math.min(4, hw));
  if (!requested || requested === "auto") return auto;
  const n = Number(requested);
  if (!Number.isFinite(n) || n < 1) return auto;
  return Math.max(1, Math.min(6, Math.floor(n)));
}

function hasRestrictiveTags(config) {
  return (config.players || []).some((p) => (p.range || "").includes("@"));
}

function mergeWorkerPayloads(payloads, playerCount) {
  const wins = new Array(playerCount).fill(0);
  const ties = new Array(playerCount).fill(0);
  const losses = new Array(playerCount).fill(0);
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
      for (let c = 0; c < 9; c++) classCounts[i][c] += p.classCounts?.[i]?.[c] || 0;
      const arr = p.comboLists?.[i] || [];
      for (let j = 0; j < arr.length; j++) comboLists[i].add(arr[j]);
    }
  }

  return { iterations, elapsedMs, wins, ties, losses, classCounts, comboLists };
}

async function runWorkers(config, workerCount, onProgress) {
  const capMs = config.mode === "quick" ? 5000 : 60000;
  const totalIterCap = Math.max(500, Number(config.iterationCap || 100000));
  const iterPerWorker = Math.max(500, Math.ceil(totalIterCap / workerCount));

  const workers = [];
  const donePayloads = [];
  let finished = 0;

  const start = performance.now();
  const progressByWorker = Array.from({ length: workerCount }, () => ({ iterations: 0, elapsed: 0 }));

  return await new Promise((resolve, reject) => {
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL("./sim-worker.js", import.meta.url), { type: "module" });
      workers.push(w);

      w.onmessage = (event) => {
        const msg = event.data;
        if (!msg) return;

        if (msg.type === "progress") {
          progressByWorker[i] = msg.progress;
          const totalIt = progressByWorker.reduce((a, x) => a + (x.iterations || 0), 0);
          const elapsed = (performance.now() - start) / 1000;
          onProgress?.({ iterations: totalIt, elapsed, ips: totalIt / Math.max(0.001, elapsed), boardClass: "multi-core" });
        }

        if (msg.type === "error") {
          workers.forEach((x) => x.terminate());
          reject(new Error(msg.error || "Worker failed"));
        }

        if (msg.type === "done") {
          donePayloads.push(msg.payload);
          finished++;
          if (finished === workerCount) {
            workers.forEach((x) => x.terminate());
            const merged = mergeWorkerPayloads(donePayloads, config.players.length);
            merged.elapsedMs = performance.now() - start;
            resolve(merged);
          }
        }
      };

      w.onerror = (err) => {
        workers.forEach((x) => x.terminate());
        reject(new Error(err?.message || "Worker execution failed"));
      };

      w.postMessage({
        type: "run",
        workerId: i,
        config,
        capMs,
        iterCap: iterPerWorker,
        seed: Number.isFinite(config.seed) ? Number(config.seed) + i * 100003 : undefined,
        poolScale: 1 / workerCount
      });
    }
  });
}

export async function runSimulation(config, onProgress) {
  const workersAvailable = typeof Worker !== "undefined";
  let workerCount = chooseWorkerCount(config);
  if (hasRestrictiveTags(config) && workerCount > 2) workerCount = 2;

  let raw;
  if (workersAvailable && workerCount > 1) {
    raw = await runWorkers(config, workerCount, onProgress);
  } else {
    raw = await runSimulationRaw(config, { onProgress });
  }

  return rawToResult(raw, config);
}
