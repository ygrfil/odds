import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = path.join(PROJECT_ROOT, "src", "percentile-tables.js");
const NATIVE_MANIFEST = path.join(PROJECT_ROOT, "native-sim", "Cargo.toml");
const NATIVE_BIN = path.join(PROJECT_ROOT, "native-sim", "target", "release", "native-sim");

const DEFAULT_VARIANTS = ["plo4", "plo5"];
const SUPPORTED_VARIANTS = new Set(["holdem", "plo4", "plo5", "plo6"]);
const DEFAULT_ITERATIONS = 50_000_000;

function parseArgs(argv) {
  const out = {
    variants: DEFAULT_VARIANTS,
    iterations: DEFAULT_ITERATIONS,
    workers: 0,
    seed: 0x9e3779b1,
    outFile: DEFAULT_OUT,
    build: true
  };

  for (const a of argv) {
    if (a.startsWith("--variants=")) {
      const wanted = a.slice("--variants=".length).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      const filtered = wanted.filter((v) => SUPPORTED_VARIANTS.has(v));
      if (filtered.length) out.variants = filtered;
      continue;
    }
    if (a.startsWith("--iterations=")) {
      const n = Number(a.slice("--iterations=".length));
      if (Number.isFinite(n) && n > 0) out.iterations = Math.floor(n);
      continue;
    }
    if (a.startsWith("--workers=")) {
      const n = Number(a.slice("--workers=".length));
      if (Number.isFinite(n) && n > 0) out.workers = Math.floor(n);
      continue;
    }
    if (a.startsWith("--seed=")) {
      const n = Number(a.slice("--seed=".length));
      if (Number.isFinite(n)) out.seed = Math.floor(n);
      continue;
    }
    if (a.startsWith("--out=")) {
      const p = a.slice("--out=".length).trim();
      if (p) out.outFile = path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p);
      continue;
    }
    if (a === "--no-build") {
      out.build = false;
      continue;
    }
  }

  return out;
}

function runProcess(bin, args, input, cwd = PROJECT_ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (d) => stdoutChunks.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderrChunks.push(Buffer.from(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(new Error(stderr || `${bin} exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    if (input != null) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

async function ensureNativeBinary(build) {
  if (!build && fs.existsSync(NATIVE_BIN)) return NATIVE_BIN;
  process.stderr.write("[equity-precompute] building native simulator (release)...\n");
  await runProcess("cargo", ["build", "--release", "--manifest-path", NATIVE_MANIFEST], null, PROJECT_ROOT);
  if (!fs.existsSync(NATIVE_BIN)) {
    throw new Error(`native simulator binary not found at ${NATIVE_BIN}`);
  }
  return NATIVE_BIN;
}

async function runEquityRank(binary, variant, iterations, workers, seed) {
  const payload = {
    mode: "equity-rank",
    variant,
    iteration_cap: iterations,
    workers: workers > 0 ? workers : undefined,
    seed
  };
  const t0 = Date.now();
  process.stderr.write(`[equity-precompute] ${variant}: running ${iterations.toLocaleString()} iterations...\n`);
  const { stdout } = await runProcess(binary, [], JSON.stringify(payload), PROJECT_ROOT);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`invalid JSON from native simulator for ${variant}: ${err?.message || err}`);
  }
  if (!parsed?.ok || !parsed?.equity_rank) {
    throw new Error(parsed?.error || `native simulator failed for ${variant}`);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  process.stderr.write(`[equity-precompute] ${variant}: done in ${elapsed}s\n`);
  return parsed.equity_rank;
}

function buildTables(resultsByVariant, iterations) {
  const tables = {};
  const now = new Date().toISOString();
  for (const [variant, r] of Object.entries(resultsByVariant)) {
    tables[variant] = {
      basis: Number(r.basis || 0),
      sampleSize: Number(r.combo_space || 0),
      source: "equity-montecarlo-vs-random",
      generatedAt: now,
      iterationCap: Number(r.iteration_cap || iterations),
      observations: Number(r.observations || 0),
      elapsedMs: Number(r.elapsed_ms || 0),
      scoreScale: Number(r.score_scale || 10_000),
      zeroSampleCombos: Number(r.zero_sample_combos || 0),
      minSamples: Number(r.min_samples || 0),
      maxSamples: Number(r.max_samples || 0),
      meanSamplesPerCombo: Number(r.mean_samples_per_combo || 0),
      scoreKeysByComboRank: Array.isArray(r.score_keys_by_combo_rank) ? r.score_keys_by_combo_rank : [],
      topScoreKeys: Array.isArray(r.top_score_keys) ? r.top_score_keys : [],
      topRanks: Array.isArray(r.top_ranks) ? r.top_ranks : []
    };
  }
  return tables;
}

function writeModule(outFile, tables) {
  const text =
    "// Auto-generated by scripts/precompute-percentiles-equity.mjs.\n" +
    "// True-equity percentile tables vs random hand (Monte Carlo, native-sim).\n" +
    "// Do not edit manually.\n\n" +
    `export const PRECOMPUTED_PERCENTILE_TABLES = ${JSON.stringify(tables, null, 2)};\n`;
  fs.writeFileSync(outFile, text, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.variants.length) {
    throw new Error("No valid variants provided. Use --variants=plo4,plo5");
  }
  const binary = await ensureNativeBinary(args.build);
  const results = {};
  for (const variant of args.variants) {
    results[variant] = await runEquityRank(binary, variant, args.iterations, args.workers, args.seed);
  }
  const tables = buildTables(results, args.iterations);
  writeModule(args.outFile, tables);
  process.stderr.write(`[equity-precompute] wrote ${args.outFile}\n`);
}

main().catch((err) => {
  process.stderr.write(`[equity-precompute] error: ${err?.message || err}\n`);
  process.exit(1);
});
