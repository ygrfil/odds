import { runSimulationRaw, rawToResult } from "./sim-core.js";

function chooseWorkerCount(config) {
  const hw = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, hw);
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

async function runWorkers(config, workerCount, onProgress, signal) {
  const totalIterCap = Math.max(500, Number(config.iterationCap || 100000));
  const start = performance.now();
  const cumulative = {
    iterations: 0,
    elapsedMs: 0,
    wins: new Array(config.players.length).fill(0),
    ties: new Array(config.players.length).fill(0),
    losses: new Array(config.players.length).fill(0),
    classCounts: Array.from({ length: config.players.length }, () => new Array(9).fill(0)),
    comboLists: Array.from({ length: config.players.length }, () => new Set())
  };

  const handSize = config.variant === "holdem" ? 2 : config.variant === "plo4" ? 4 : config.variant === "plo5" ? 5 : 6;
  const batchPerWorker = handSize === 2 ? 4000 : handSize === 4 ? 2500 : 1500;

  async function runBatch(iterPerWorker, batchIndex) {
    const workers = [];
    const donePayloads = [];
    let finished = 0;
    return await new Promise((resolve, reject) => {
      const abortHandler = () => {
        workers.forEach((x) => x.terminate());
        resolve(null);
      };
      if (signal) signal.addEventListener("abort", abortHandler, { once: true });

      for (let i = 0; i < workerCount; i++) {
        const w = new Worker(new URL("./sim-worker.js", import.meta.url), { type: "module" });
        workers.push(w);

        w.onmessage = (event) => {
          const msg = event.data;
          if (!msg) return;
          if (msg.type === "error") {
            workers.forEach((x) => x.terminate());
            reject(new Error(msg.error || "Worker failed"));
            return;
          }
          if (msg.type === "done") {
            donePayloads.push(msg.payload);
            finished++;
            if (finished === workerCount) {
              workers.forEach((x) => x.terminate());
              resolve(donePayloads);
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
          iterCap: iterPerWorker,
          seed: batchIndex * 1000003 + i * 100003 + 17,
          poolScale: 1 / workerCount
        });
      }
    });
  }

  let batch = 0;
  while (cumulative.iterations < totalIterCap) {
    if (signal?.aborted) break;
    const remaining = totalIterCap - cumulative.iterations;
    const iterPerWorker = Math.max(1, Math.min(batchPerWorker, Math.ceil(remaining / workerCount)));
    const payloads = await runBatch(iterPerWorker, batch++);
    if (!payloads || payloads.length === 0) break;
    const merged = mergeWorkerPayloads(payloads, config.players.length);
    cumulative.iterations += merged.iterations;
    for (let p = 0; p < config.players.length; p++) {
      cumulative.wins[p] += merged.wins[p];
      cumulative.ties[p] += merged.ties[p];
      cumulative.losses[p] += merged.losses[p];
      for (let c = 0; c < 9; c++) cumulative.classCounts[p][c] += merged.classCounts[p][c];
      for (const key of merged.comboLists[p]) cumulative.comboLists[p].add(key);
    }
    cumulative.elapsedMs = performance.now() - start;
    const elapsed = cumulative.elapsedMs / 1000;
    onProgress?.({
      iterations: cumulative.iterations,
      elapsed,
      ips: cumulative.iterations / Math.max(0.001, elapsed),
      boardClass: "multi-core"
    });
  }

  cumulative.elapsedMs = performance.now() - start;
  return cumulative;
}

export async function runSimulation(config, onProgress, signal) {
  const workersAvailable = typeof Worker !== "undefined";
  const workerCount = chooseWorkerCount(config);

  let raw;
  if (workersAvailable && workerCount > 1) {
    raw = await runWorkers(config, workerCount, onProgress, signal);
  } else {
    raw = await runSimulationRaw(config, { onProgress, signal });
  }

  return rawToResult(raw, config);
}
