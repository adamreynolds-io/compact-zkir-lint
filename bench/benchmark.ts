/**
 * Proof server benchmark tool for zkir-lint.
 *
 * Sends pre-recorded binary payloads to a proof server's /prove endpoint,
 * measures wall-clock proving time, and outputs a .zkir-lint.json-compatible
 * EnvironmentConfig with real timing data.
 *
 * Zero Midnight SDK dependencies — uses only Node built-ins + fetch.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";

// --- Types ---

interface FixtureMeta {
  k: number;
  circuit: string;
  contract: string;
  rows?: number;
  tableRows?: number;
  hashes?: number;
  instructions?: number;
  payloadBytes?: number;
  sdkVersion?: string;
  recordedAt?: string;
}

interface BenchmarkResult {
  k: number;
  circuit: string;
  rows: number;
  tableRows: number;
  hashes: number;
  instructions: number;
  payloadBytes: number;
  timingsMs: number[];
  medianMs: number;
  minMs: number;
  maxMs: number;
  p5Ms: number;
  p95Ms: number;
  errors: number;
}

interface EnvironmentConfig {
  label: string;
  maxK: number;
  warnK: number;
  timings: [number, number, number][];
}

interface BenchmarkSummary {
  serverUrl: string;
  timestamp: string;
  label: string;
  results: BenchmarkResult[];
  environmentConfig: EnvironmentConfig;
}

interface CliArgs {
  serverUrl: string;
  iterations: number;
  timeoutMs: number;
  fixtureDir: string;
  targetK: number[];
  label: string;
  warnThreshold: number;
  output: string | null;
  format: "env" | "full";
}

// --- CLI Parsing ---

function parseCliArgs(): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        "server-url": { type: "string", default: "http://localhost:6300" },
        server: { type: "string" },
        iterations: { type: "string", default: "3", short: "n" },
        timeout: { type: "string", default: "600000" },
        "fixture-dir": { type: "string", default: "bench/fixtures" },
        fixtures: { type: "string" },
        "target-k": { type: "string" },
        label: { type: "string", default: "benchmarked" },
        "warn-threshold": { type: "string", default: "60" },
        output: { type: "string", short: "o" },
        format: { type: "string", default: "env", short: "f" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    console.error("\nRun with --help for usage.");
    process.exit(1);
  }

  const { values } = parsed;

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const format = values.format as string;
  if (format !== "env" && format !== "full") {
    console.error(`Invalid --format: "${format}". Must be "env" or "full".`);
    process.exit(1);
  }

  // Resolve aliases
  const serverUrl =
    (values.server as string) ??
    (values["server-url"] as string);
  const fixtureDir = resolve(
    (values.fixtures as string) ??
      (values["fixture-dir"] as string),
  );

  // Validate server URL
  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      console.error(`Invalid server URL protocol: ${parsed.protocol}`);
      process.exit(1);
    }
  } catch {
    console.error(`Invalid server URL: ${serverUrl}`);
    process.exit(1);
  }

  // Validate numeric args
  const iterations = Number(values.iterations);
  const timeoutMs = Number(values.timeout);
  const warnThreshold = Number(values["warn-threshold"]);

  if (!Number.isFinite(iterations) || iterations < 1 || iterations > 100) {
    console.error("--iterations must be 1-100");
    process.exit(1);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) {
    console.error("--timeout must be 1000-3600000 (1s to 1h)");
    process.exit(1);
  }
  if (!Number.isFinite(warnThreshold) || warnThreshold < 1) {
    console.error("--warn-threshold must be a positive number");
    process.exit(1);
  }

  const targetK = values["target-k"]
    ? (values["target-k"] as string).split(",").map(Number)
    : [];
  if (targetK.some((k) => !Number.isInteger(k) || k < 1 || k > 30)) {
    console.error("--target-k values must be integers 1-30");
    process.exit(1);
  }

  return {
    serverUrl,
    iterations,
    timeoutMs,
    fixtureDir,
    targetK,
    label: values.label as string,
    warnThreshold,
    output: (values.output as string) ?? null,
    format: format as "env" | "full",
  };
}

function printUsage(): void {
  console.log(`zkir-bench: Benchmark a Midnight proof server

Usage: npm run benchmark -- [options]

Options:
  --server-url, --server <url>   Proof server URL (default: http://localhost:6300)
  -n, --iterations <n>           Iterations per fixture (default: 3)
  --timeout <ms>                 Per-request timeout in ms (default: 600000)
  --fixture-dir, --fixtures <p>  Directory with .bin fixtures (default: bench/fixtures)
  --target-k <k,...>             Only benchmark specific k values
  --label <name>                 Environment label (default: "benchmarked")
  --warn-threshold <s>           Seconds threshold for warnK (default: 60)
  -o, --output <path>            Write JSON to file (default: stdout)
  -f, --format env|full          env = EnvironmentConfig; full = detailed (default: env)
  -h, --help                     Show this help

Examples:
  npm run benchmark
  npm run benchmark -- --server http://my-server:6300 --label "GPU box"
  npm run benchmark -- -n 5 -o profile.json
  npm run benchmark -- --target-k 10,12,14`);
}

// --- Fixture Discovery ---

const FIXTURE_PATTERN = /^k(\d+)-(.+)\.bin$/;

interface Fixture {
  path: string;
  k: number;
  name: string;
  meta: FixtureMeta | null;
}

async function discoverFixtures(
  dir: string,
  targetK: number[],
): Promise<Fixture[]> {
  const entries = await readdir(dir);
  const fixtures: Fixture[] = [];

  for (const entry of entries) {
    const match = FIXTURE_PATTERN.exec(entry);
    if (!match) continue;

    const k = Number(match[1]);
    const name = match[2];

    if (targetK.length > 0 && !targetK.includes(k)) continue;

    const metaPath = join(dir, entry.replace(/\.bin$/, ".meta.json"));
    let meta: FixtureMeta | null = null;
    try {
      meta = JSON.parse(await readFile(metaPath, "utf-8")) as FixtureMeta;
    } catch {
      // No metadata sidecar — that's fine
    }

    fixtures.push({ path: join(dir, entry), k, name, meta });
  }

  fixtures.sort((a, b) => a.k - b.k);
  return fixtures;
}

// --- File Loading ---

const MAX_FIXTURE_BYTES = 500 * 1024 * 1024; // 500MB

async function readFixture(path: string): Promise<Buffer> {
  const { stat } = await import("node:fs/promises");
  const info = await stat(path);
  if (info.size > MAX_FIXTURE_BYTES) {
    throw new Error(
      `Fixture ${path} is ${(info.size / 1024 / 1024).toFixed(0)}MB, ` +
        `exceeds limit of ${MAX_FIXTURE_BYTES / 1024 / 1024}MB`,
    );
  }
  return readFile(path);
}

// --- Server Readiness ---

interface ReadyResponse {
  status: string;
  jobsProcessing: number;
  jobsPending: number;
  jobCapacity: number;
}

async function checkServerReady(
  serverUrl: string,
): Promise<ReadyResponse | null> {
  try {
    const res = await fetch(`${serverUrl}/ready`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as ReadyResponse;
  } catch {
    return null;
  }
}

// --- Benchmarking ---

async function benchmarkFixture(
  serverUrl: string,
  payload: Uint8Array,
  iterations: number,
  timeoutMs: number,
): Promise<{ timingsMs: number[]; errors: number }> {
  const timingsMs: number[] = [];
  let errors = 0;

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    try {
      const res = await fetch(`${serverUrl}/prove`, {
        method: "POST",
        body: payload,
        headers: { "Content-Type": "application/octet-stream" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.arrayBuffer();
      const elapsed = performance.now() - start;

      if (!res.ok) {
        errors++;
        console.error(
          `  iteration ${i + 1}: HTTP ${res.status} (${elapsed.toFixed(0)}ms)`,
        );
        continue;
      }

      timingsMs.push(elapsed);
    } catch (err) {
      errors++;
      const elapsed = performance.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `  iteration ${i + 1}: ${msg} (${elapsed.toFixed(0)}ms)`,
      );
    }
  }

  return { timingsMs, errors };
}

// --- Statistics ---

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeStats(timingsMs: number[]): {
  medianMs: number;
  minMs: number;
  maxMs: number;
  p5Ms: number;
  p95Ms: number;
} {
  const sorted = [...timingsMs].sort((a, b) => a - b);
  return {
    medianMs: percentile(sorted, 50),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    p5Ms: percentile(sorted, 5),
    p95Ms: percentile(sorted, 95),
  };
}

// --- Summary Display ---

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  if (s < 0.01) return "<0.01s";
  if (s < 1) return `${s.toFixed(2)}s`;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "-";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function bar(value: number, max: number, width: number): string {
  const filled = Math.round((value / max) * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

function printSummaryTable(results: BenchmarkResult[]): void {
  const successful = results.filter((r) => r.timingsMs.length > 0);
  if (successful.length === 0) {
    console.log("No successful benchmarks.");
    return;
  }

  const maxMedian = Math.max(...successful.map((r) => r.medianMs));
  const BAR_WIDTH = 20;

  // Header
  console.log(
    "  k   " +
      "rows".padStart(8) +
      "  tblRows" +
      "  hashes" +
      "  instrs" +
      "  payload" +
      "    proving time".padEnd(12) +
      "  " +
      "distribution",
  );
  console.log("  " + "-".repeat(88));

  // k formula explanation
  console.log(
    "  k = ceil(log2(max(rows, tableRows, instances) + 6))",
  );
  console.log();

  for (const r of results) {
    const kStr = String(r.k).padStart(3);
    const rowsStr = String(r.rows).padStart(8);
    const tblStr = String(r.tableRows).padStart(8);
    const hashStr = String(r.hashes).padStart(7);
    const instrStr = String(r.instructions).padStart(7);
    const payloadStr = formatBytes(r.payloadBytes).padStart(8);

    if (r.timingsMs.length === 0) {
      const reason =
        r.payloadBytes > 100 * 1024 * 1024
          ? "FAILED (payload too large for proof server)"
          : "FAILED";
      console.log(
        `  ${kStr} ${rowsStr} ${tblStr} ${hashStr} ${instrStr} ${payloadStr}    ${reason}`,
      );
      continue;
    }

    const timeStr = formatSeconds(r.medianMs).padStart(8);
    const rangeStr =
      `[${formatSeconds(r.minMs)}-${formatSeconds(r.maxMs)}]`.padEnd(16);
    const barStr = bar(r.medianMs, maxMedian, BAR_WIDTH);

    console.log(
      `  ${kStr} ${rowsStr} ${tblStr} ${hashStr} ${instrStr} ${payloadStr}  ${timeStr} ${rangeStr} ${barStr}`,
    );
  }

  // Extrapolated timings
  const extrapolated = extrapolateTimings(successful);
  const projected = extrapolated.filter((t) => t.extrapolated);
  if (projected.length > 0) {
    console.log();
    console.log("  Extrapolated (doubling per k):");
    for (const t of projected) {
      const kStr = String(t.k).padStart(3);
      const timeStr = formatSeconds(t.lowS * 1000).padStart(8);
      const srsNote =
        t.k > 15 ? ` (SRS: ${SRS_SIZES[t.k] ?? ">6GB"})` : "";
      console.log(`  ${kStr}  ${timeStr}${srsNote}`);
    }
  }
}

// --- Extrapolation ---

const MAX_EXTRAPOLATED_K = 25;

// SRS curve file sizes (bls_midnight_2p{k}). Doubles per k.
const SRS_SIZES: Record<number, string> = {
  16: "12MB", 17: "24MB", 18: "48MB", 19: "96MB", 20: "192MB",
  21: "384MB", 22: "768MB", 23: "1.5GB", 24: "3GB", 25: "6GB",
};

/**
 * Estimate the doubling factor per k from the last two successful results.
 * Falls back to 2.0 (theoretical doubling) if insufficient data.
 */
function estimateDoublingFactor(
  successful: BenchmarkResult[],
): number {
  if (successful.length < 2) return 2.0;
  const last = successful[successful.length - 1]!;
  const prev = successful[successful.length - 2]!;
  if (prev.medianMs <= 0 || last.k === prev.k) return 2.0;
  const kDiff = last.k - prev.k;
  return (last.medianMs / prev.medianMs) ** (1 / kDiff);
}

function extrapolateTimings(
  successful: BenchmarkResult[],
): Array<{ k: number; lowS: number; highS: number; extrapolated: boolean }> {
  const entries = successful.map((r) => ({
    k: r.k,
    lowS: r.p5Ms / 1000,
    highS: r.p95Ms / 1000,
    extrapolated: false,
  }));

  if (successful.length === 0) return entries;

  const factor = estimateDoublingFactor(successful);
  const last = entries[entries.length - 1]!;

  for (let k = last.k + 1; k <= MAX_EXTRAPOLATED_K; k++) {
    const prev = entries[entries.length - 1]!;
    entries.push({
      k,
      lowS: prev.lowS * factor,
      highS: prev.highS * factor,
      extrapolated: true,
    });
  }

  return entries;
}

// --- Config Generation ---

function resultsToEnvironmentConfig(
  results: BenchmarkResult[],
  label: string,
  warnThresholdS: number,
): EnvironmentConfig {
  const successful = results.filter((r) => r.timingsMs.length > 0);
  if (successful.length === 0) {
    return { label, maxK: 0, warnK: 0, timings: [] };
  }

  const allTimings = extrapolateTimings(successful);
  const timings: [number, number, number][] = allTimings.map((t) => [
    t.k,
    t.lowS,
    t.highS,
  ]);

  const maxK = allTimings[allTimings.length - 1]!.k;
  let warnK = 0;
  for (const t of allTimings) {
    if (t.highS <= warnThresholdS) {
      warnK = t.k;
    }
  }

  return { label, maxK, warnK, timings };
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseCliArgs();

  console.log(`zkir-bench`);
  console.log(`  server:     ${args.serverUrl}`);
  console.log(`  iterations: ${args.iterations}`);
  console.log(`  timeout:    ${args.timeoutMs}ms`);
  console.log(`  fixtures:   ${args.fixtureDir}`);
  console.log();

  const ready = await checkServerReady(args.serverUrl);
  if (!ready) {
    console.error(
      `Proof server at ${args.serverUrl} is not reachable. ` +
        `Start it with: docker run -p 6300:6300 ghcr.io/midnight-ntwrk/proof-server:8.0.3`,
    );
    process.exit(1);
  }
  console.log(
    `Server ready: ${ready.jobCapacity} workers, ` +
      `${ready.jobsProcessing} processing, ${ready.jobsPending} pending`,
  );
  console.log();

  const fixtures = await discoverFixtures(args.fixtureDir, args.targetK);
  if (fixtures.length === 0) {
    console.error(
      `No benchmark fixtures found in ${args.fixtureDir}.\n\n` +
        `Run setup first:\n` +
        `  npm run benchmark:setup\n\n` +
        `This requires the Compact compiler (compact compile).`,
    );
    process.exit(1);
  }

  console.log(`Found ${fixtures.length} fixture(s):`);
  for (const f of fixtures) {
    const circuit = f.meta?.circuit ?? f.name;
    console.log(`  k=${f.k}  ${circuit}`);
  }
  console.log();

  // --- Preflight: warm up server and verify it can prove k=10 ---
  const smallest = fixtures[0]!; // sorted by k ascending
  const preflightPayload = await readFixture(smallest.path);
  console.log(
    `Preflight: warming up server with k=${smallest.k}...`,
  );
  const { timingsMs: preflightTimings, errors: preflightErrors } =
    await benchmarkFixture(
      args.serverUrl,
      preflightPayload,
      1,
      args.timeoutMs,
    );
  if (preflightTimings.length === 0) {
    console.error(
      `Preflight failed: proof server could not prove k=${smallest.k}. ` +
        `Check that the server is running and fixtures are valid.`,
    );
    process.exit(1);
  }
  console.log(
    `Preflight OK: k=${smallest.k} proved in ${(preflightTimings[0]! / 1000).toFixed(1)}s`,
  );
  console.log();

  const results: BenchmarkResult[] = [];

  for (const fixture of fixtures) {
    const circuit = fixture.meta?.circuit ?? fixture.name;
    const meta = fixture.meta;
    const circuitStats = {
      rows: meta?.rows ?? 0,
      tableRows: meta?.tableRows ?? 0,
      hashes: meta?.hashes ?? 0,
      instructions: meta?.instructions ?? 0,
      payloadBytes: meta?.payloadBytes ?? 0,
    };

    let payload: Buffer;
    try {
      payload = await readFixture(fixture.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Skipping k=${fixture.k} (${circuit}): ${msg}`);
      results.push({
        k: fixture.k,
        circuit,
        ...circuitStats,
        timingsMs: [],
        medianMs: 0,
        minMs: 0,
        maxMs: 0,
        p5Ms: 0,
        p95Ms: 0,
        errors: 1,
      });
      continue;
    }

    console.log(`Benchmarking k=${fixture.k} (${circuit})...`);

    // Warmup (always run 1 warmup per fixture for SRS loading)
    await benchmarkFixture(
      args.serverUrl,
      payload,
      1,
      args.timeoutMs,
    );

    // Benchmark
    const { timingsMs, errors } = await benchmarkFixture(
      args.serverUrl,
      payload,
      args.iterations,
      args.timeoutMs,
    );

    if (timingsMs.length === 0) {
      console.log(`  FAILED: all ${args.iterations} iterations errored`);
      results.push({
        k: fixture.k,
        circuit,
        ...circuitStats,
        timingsMs: [],
        medianMs: 0,
        minMs: 0,
        maxMs: 0,
        p5Ms: 0,
        p95Ms: 0,
        errors,
      });
      continue;
    }

    const stats = computeStats(timingsMs);
    console.log(
      `  median=${(stats.medianMs / 1000).toFixed(1)}s  ` +
        `range=[${(stats.minMs / 1000).toFixed(1)}s, ${(stats.maxMs / 1000).toFixed(1)}s]  ` +
        `errors=${errors}`,
    );

    results.push({
      k: fixture.k,
      circuit,
      ...circuitStats,
      timingsMs,
      ...stats,
      errors,
    });
  }

  // --- Visual Summary ---
  console.log();
  printSummaryTable(results);
  console.log();

  const envConfig = resultsToEnvironmentConfig(
    results,
    args.label,
    args.warnThreshold,
  );

  // Wrap in LintConfig format so output is directly usable with --profile-config
  const envName = args.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  let output: string;
  if (args.format === "env") {
    output = JSON.stringify(
      { environments: { [envName]: envConfig } },
      null,
      2,
    );
  } else {
    const summary: BenchmarkSummary = {
      serverUrl: args.serverUrl,
      timestamp: new Date().toISOString(),
      label: args.label,
      results,
      environmentConfig: envConfig,
    };
    output = JSON.stringify(summary, null, 2);
  }

  if (args.output) {
    await writeFile(args.output, output + "\n", "utf-8");
    console.log(`Profile written to ${args.output}`);
    console.log(
      `Use with: npx zkir-lint --profile --profile-config ${args.output} circuit.zkir`,
    );
  } else {
    console.log(output);
  }
}

// --- Exports for testing ---

export {
  discoverFixtures,
  checkServerReady,
  benchmarkFixture,
  computeStats,
  percentile,
  resultsToEnvironmentConfig,
};
export type {
  Fixture,
  FixtureMeta,
  BenchmarkResult,
  EnvironmentConfig,
  BenchmarkSummary,
};

// Run as CLI when executed directly
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("benchmark.ts") ||
    process.argv[1].endsWith("benchmark.js"));

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
