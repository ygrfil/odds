import { runSimulationRaw } from "./sim-core.js";

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || msg.type !== "run") return;

  try {
    const raw = await runSimulationRaw(msg.config, {
      iterCap: msg.iterCap,
      seedOverride: msg.seed,
      poolScale: msg.poolScale,
      disableStabilityStop: true
    });

    self.postMessage({
      type: "done",
      workerId: msg.workerId,
      payload: {
        iterations: raw.iterations,
        elapsedMs: raw.elapsedMs,
        wins: raw.wins,
        ties: raw.ties,
        losses: raw.losses,
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
  }
};
