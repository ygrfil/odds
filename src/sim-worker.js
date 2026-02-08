import { runExhaustiveRaw, runSimulationRaw } from "./sim-core.js";

let activeController = null;
let runToken = 0;

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === "stop") {
    if (activeController) activeController.abort();
    return;
  }
  if (msg.type !== "run") return;

  try {
    const token = ++runToken;
    activeController = new AbortController();
    const runner = msg.mode === "exact" ? runExhaustiveRaw : runSimulationRaw;
    const raw = await runner(msg.config, {
      iterCap: msg.iterCap,
      seedOverride: msg.seed,
      poolScale: msg.poolScale,
      partitionIndex: msg.partitionIndex,
      partitionCount: msg.partitionCount,
      disableStabilityStop: true,
      signal: activeController.signal,
      onProgress: (p) => {
        self.postMessage({
          type: "progress",
          workerId: msg.workerId,
          progress: {
            iterations: p.iterations || 0
          }
        });
      }
    });
    if (token !== runToken) return;

    self.postMessage({
      type: "done",
      workerId: msg.workerId,
      payload: {
        iterations: raw.iterations,
        elapsedMs: raw.elapsedMs,
        wins: raw.wins,
        ties: raw.ties,
        losses: raw.losses,
        equityShares: raw.equityShares,
        comboLists: raw.comboLists.map((s) => Array.from(s)),
        classCounts: raw.classCounts
      }
    });
  } catch (err) {
    self.postMessage({
      type: "error",
      workerId: msg.workerId,
      error: err?.message || String(err)
    });
  } finally {
    activeController = null;
  }
};
