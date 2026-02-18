import { rawToResult } from "./result-format.js";

class BackendUnavailableError extends Error {
  constructor(message) {
    super(message || "Native backend unavailable");
    this.name = "BackendUnavailableError";
  }
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
  if (!canTryBackend) {
    throw new BackendUnavailableError("Backend endpoint is not available. Open app over http:// with backend running.");
  }
  return await runSimulationBackend(config, onProgress, signal);
}
