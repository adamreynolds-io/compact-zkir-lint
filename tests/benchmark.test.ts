/**
 * E2E tests for the proof server benchmark tool.
 *
 * Spins up a mock HTTP server that simulates proof server endpoints,
 * creates temporary binary fixtures, and validates the full benchmark
 * pipeline: discovery → timing → stats → EnvironmentConfig generation.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverFixtures,
  checkServerReady,
  benchmarkFixture,
  computeStats,
  percentile,
  resultsToEnvironmentConfig,
  type BenchmarkResult,
  type EnvironmentConfig,
} from "../bench/benchmark.js";
import { profileCircuit, type EnvironmentConfig as ProfileEnvConfig } from "../src/profile.js";
import type { ZkirV2 } from "../src/types.js";

// --- Mock Proof Server ---

interface MockServerConfig {
  proveDelayMs: number;
  proveFailRate: number;
}

function createMockProofServer(
  config: MockServerConfig,
): { server: Server; url: string; close: () => Promise<void> } {
  let requestCount = 0;

  const server = createServer((req, res) => {
    if (req.url === "/ready" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          jobsProcessing: 0,
          jobsPending: 0,
          jobCapacity: 4,
        }),
      );
      return;
    }

    if (req.url === "/prove" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requestCount++;
        const shouldFail =
          config.proveFailRate > 0 &&
          requestCount % Math.round(1 / config.proveFailRate) === 0;

        setTimeout(() => {
          if (shouldFail) {
            res.writeHead(500);
            res.end("Internal Server Error");
          } else {
            // Return a dummy proof (32 bytes)
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
            });
            res.end(Buffer.alloc(32, 0xab));
          }
        }, config.proveDelayMs);
      });
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  const url = `http://127.0.0.1:0`;

  return {
    server,
    get url() {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        return `http://127.0.0.1:${addr.port}`;
      }
      return url;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// --- Test Fixtures ---

function createFixtureDir(
  fixtures: { name: string; k: number; data?: Buffer }[],
): string {
  const dir = mkdtempSync(join(tmpdir(), "zkir-bench-test-"));
  const fixturesDir = join(dir, "fixtures");
  mkdirSync(fixturesDir);

  for (const f of fixtures) {
    const data = f.data ?? Buffer.alloc(64, 0xff);
    writeFileSync(join(fixturesDir, `k${f.k}-${f.name}.bin`), data);
    writeFileSync(
      join(fixturesDir, `k${f.k}-${f.name}.meta.json`),
      JSON.stringify({
        k: f.k,
        circuit: f.name,
        contract: "test",
        sdkVersion: "test",
        recordedAt: new Date().toISOString(),
      }),
    );
  }

  return fixturesDir;
}

// --- Tests ---

describe("percentile", () => {
  it("returns single value for single-element array", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 100)).toBe(42);
  });

  it("returns 0 for empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("computes median of sorted array", () => {
    expect(percentile([1, 2, 3], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
  });

  it("computes extremes correctly", () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
    expect(percentile([10, 20, 30], 100)).toBe(30);
  });

  it("interpolates p5 and p95", () => {
    const data = [100, 200, 300, 400, 500];
    const p5 = percentile(data, 5);
    const p95 = percentile(data, 95);
    expect(p5).toBeGreaterThanOrEqual(100);
    expect(p5).toBeLessThan(200);
    expect(p95).toBeGreaterThan(400);
    expect(p95).toBeLessThanOrEqual(500);
  });
});

describe("computeStats", () => {
  it("computes stats for multiple values", () => {
    const stats = computeStats([100, 200, 300, 400, 500]);
    expect(stats.medianMs).toBe(300);
    expect(stats.minMs).toBe(100);
    expect(stats.maxMs).toBe(500);
    expect(stats.p5Ms).toBeGreaterThanOrEqual(100);
    expect(stats.p95Ms).toBeLessThanOrEqual(500);
  });

  it("handles single value", () => {
    const stats = computeStats([42]);
    expect(stats.medianMs).toBe(42);
    expect(stats.minMs).toBe(42);
    expect(stats.maxMs).toBe(42);
  });
});

describe("discoverFixtures", () => {
  it("discovers and sorts fixtures by k", async () => {
    const dir = createFixtureDir([
      { name: "big-circuit", k: 16 },
      { name: "small-circuit", k: 10 },
      { name: "medium-circuit", k: 13 },
    ]);

    const fixtures = await discoverFixtures(dir, []);
    expect(fixtures).toHaveLength(3);
    expect(fixtures[0]!.k).toBe(10);
    expect(fixtures[1]!.k).toBe(13);
    expect(fixtures[2]!.k).toBe(16);
  });

  it("filters by target k values", async () => {
    const dir = createFixtureDir([
      { name: "a", k: 10 },
      { name: "b", k: 12 },
      { name: "c", k: 14 },
    ]);

    const fixtures = await discoverFixtures(dir, [10, 14]);
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0]!.k).toBe(10);
    expect(fixtures[1]!.k).toBe(14);
  });

  it("loads metadata sidecars", async () => {
    const dir = createFixtureDir([{ name: "test-circuit", k: 12 }]);

    const fixtures = await discoverFixtures(dir, []);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]!.meta).not.toBeNull();
    expect(fixtures[0]!.meta!.circuit).toBe("test-circuit");
    expect(fixtures[0]!.meta!.k).toBe(12);
  });

  it("returns empty array when no fixtures match", async () => {
    const dir = createFixtureDir([{ name: "a", k: 10 }]);
    const fixtures = await discoverFixtures(dir, [99]);
    expect(fixtures).toHaveLength(0);
  });
});

describe("resultsToEnvironmentConfig", () => {
  it("generates valid EnvironmentConfig with extrapolation to k=25", () => {
    const results: BenchmarkResult[] = [
      {
        k: 10,
        circuit: "small",
        rows: 0, tableRows: 0, hashes: 0, instructions: 0, payloadBytes: 0,
        timingsMs: [800, 1000, 1200],
        medianMs: 1000,
        minMs: 800,
        maxMs: 1200,
        p5Ms: 800,
        p95Ms: 1200,
        errors: 0,
      },
      {
        k: 14,
        circuit: "medium",
        rows: 0, tableRows: 0, hashes: 0, instructions: 0, payloadBytes: 0,
        timingsMs: [25000, 30000, 35000],
        medianMs: 30000,
        minMs: 25000,
        maxMs: 35000,
        p5Ms: 25000,
        p95Ms: 35000,
        errors: 0,
      },
    ];

    const config = resultsToEnvironmentConfig(results, "Test Server", 60);

    expect(config.label).toBe("Test Server");
    // Extrapolates from k=14 to k=25
    expect(config.maxK).toBe(25);
    // Measured timings + extrapolated
    expect(config.timings.length).toBeGreaterThan(2);
    // First two are measured
    expect(config.timings[0]).toEqual([10, 0.8, 1.2]);
    expect(config.timings[1]).toEqual([14, 25, 35]);
    // k=25 entry exists (extrapolated)
    const k25 = config.timings.find((t) => t[0] === 25);
    expect(k25).toBeDefined();
    // warnK should be 14 (k=14 p95=35s < 60s, extrapolated k=15+ exceed 60s)
    expect(config.warnK).toBe(14);
  });

  it("handles all-failed results", () => {
    const results: BenchmarkResult[] = [
      {
        k: 10,
        circuit: "broken",
        timingsMs: [],
        medianMs: 0,
        minMs: 0,
        maxMs: 0,
        p5Ms: 0,
        p95Ms: 0,
        errors: 3,
      },
    ];

    const config = resultsToEnvironmentConfig(results, "Broken", 60);
    expect(config.maxK).toBe(0);
    expect(config.warnK).toBe(0);
    expect(config.timings).toHaveLength(0);
  });

  it("warnK is 0 when all results exceed threshold", () => {
    const results: BenchmarkResult[] = [
      {
        k: 10,
        circuit: "slow",
        rows: 0, tableRows: 0, hashes: 0, instructions: 0, payloadBytes: 0,
        timingsMs: [90000],
        medianMs: 90000,
        minMs: 90000,
        maxMs: 90000,
        p5Ms: 90000,
        p95Ms: 90000,
        errors: 0,
      },
    ];

    const config = resultsToEnvironmentConfig(results, "Slow", 60);
    expect(config.maxK).toBe(25); // extrapolates to 25
    expect(config.warnK).toBe(0); // all exceed threshold
  });
});

describe("mock proof server integration", () => {
  let mock: ReturnType<typeof createMockProofServer>;

  beforeAll(async () => {
    mock = createMockProofServer({ proveDelayMs: 10, proveFailRate: 0 });
    await new Promise<void>((resolve) => {
      mock.server.listen(0, "127.0.0.1", resolve);
    });
  });

  afterAll(async () => {
    await mock.close();
  });

  it("checkServerReady returns status from mock", async () => {
    const ready = await checkServerReady(mock.url);
    expect(ready).not.toBeNull();
    expect(ready!.jobCapacity).toBe(4);
    expect(ready!.jobsProcessing).toBe(0);
  });

  it("checkServerReady returns null for unreachable server", async () => {
    const ready = await checkServerReady("http://127.0.0.1:1");
    expect(ready).toBeNull();
  });

  it("benchmarkFixture returns timing data", async () => {
    const payload = new Uint8Array(64);
    const { timingsMs, errors } = await benchmarkFixture(
      mock.url,
      payload,
      3,
      5000,
    );

    expect(errors).toBe(0);
    expect(timingsMs).toHaveLength(3);
    for (const t of timingsMs) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(5000);
    }
  });

  it("benchmarkFixture handles server errors gracefully", async () => {
    const errorMock = createMockProofServer({
      proveDelayMs: 1,
      proveFailRate: 1, // Fail every request
    });
    await new Promise<void>((resolve) => {
      errorMock.server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const payload = new Uint8Array(64);
      const { timingsMs, errors } = await benchmarkFixture(
        errorMock.url,
        payload,
        3,
        5000,
      );

      expect(errors).toBe(3);
      expect(timingsMs).toHaveLength(0);
    } finally {
      await errorMock.close();
    }
  });

  it("full pipeline: fixtures → benchmark → EnvironmentConfig", async () => {
    const dir = createFixtureDir([
      { name: "small", k: 10 },
      { name: "medium", k: 14 },
    ]);

    const fixtures = await discoverFixtures(dir, []);
    expect(fixtures).toHaveLength(2);

    const results: BenchmarkResult[] = [];

    for (const fixture of fixtures) {
      const payload = new Uint8Array(
        await import("node:fs/promises").then((fs) =>
          fs.readFile(fixture.path),
        ),
      );

      const { timingsMs, errors } = await benchmarkFixture(
        mock.url,
        payload,
        2,
        5000,
      );

      const sorted = [...timingsMs].sort((a, b) => a - b);
      results.push({
        k: fixture.k,
        circuit: fixture.meta?.circuit ?? fixture.name,
        rows: 0, tableRows: 0, hashes: 0, instructions: 0, payloadBytes: 0,
        timingsMs,
        medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
        minMs: sorted[0] ?? 0,
        maxMs: sorted[sorted.length - 1] ?? 0,
        p5Ms: sorted[0] ?? 0,
        p95Ms: sorted[sorted.length - 1] ?? 0,
        errors,
      });
    }

    const config = resultsToEnvironmentConfig(results, "Mock Server", 60);

    expect(config.label).toBe("Mock Server");
    expect(config.maxK).toBe(25); // extrapolated
    // First two are measured, rest extrapolated
    expect(config.timings[0]![0]).toBe(10);
    expect(config.timings[1]![0]).toBe(14);

    // Measured timings should be very small (mock delay is 10ms)
    expect(config.timings[0]![1]).toBeLessThan(1);
    expect(config.timings[1]![1]).toBeLessThan(1);

    // warnK should be 25 since all timings (including extrapolated) are tiny
    expect(config.warnK).toBe(25);
  });
});

describe("e2e: real fixtures → mock server → profiler integration", () => {
  const FIXTURE_DIR = join(import.meta.dirname, "..", "bench", "fixtures");
  const ZKIR_DIR = join(
    import.meta.dirname,
    "..",
    "bench",
    "benchmark-compiled",
    "zkir",
  );
  const hasFixtures =
    existsSync(FIXTURE_DIR) && existsSync(join(FIXTURE_DIR, "k10-benchmark-bench_k10.bin"));
  const hasZkir =
    existsSync(ZKIR_DIR) && existsSync(join(ZKIR_DIR, "bench_k10.zkir"));

  let mock: ReturnType<typeof createMockProofServer>;

  beforeAll(async () => {
    mock = createMockProofServer({ proveDelayMs: 5, proveFailRate: 0 });
    await new Promise<void>((resolve) => {
      mock.server.listen(0, "127.0.0.1", resolve);
    });
  });

  afterAll(async () => {
    await mock.close();
  });

  it.skipIf(!hasFixtures)(
    "discovers real benchmark fixtures at k=10, k=11, k=12",
    async () => {
      const fixtures = await discoverFixtures(FIXTURE_DIR, []);
      expect(fixtures.length).toBeGreaterThanOrEqual(3);

      const ks = fixtures.map((f) => f.k);
      expect(ks).toContain(10);
      expect(ks).toContain(11);
      expect(ks).toContain(12);

      for (const f of fixtures) {
        expect(f.meta).not.toBeNull();
        expect(f.meta!.contract).toBe("benchmark");
      }
    },
  );

  it.skipIf(!hasFixtures)(
    "benchmarks real fixtures against mock server and produces valid EnvironmentConfig",
    async () => {
      const fixtures = await discoverFixtures(FIXTURE_DIR, [10, 11, 12]);
      expect(fixtures.length).toBe(3);

      const results: BenchmarkResult[] = [];

      for (const fixture of fixtures) {
        const payload = readFileSync(fixture.path);
        const { timingsMs, errors } = await benchmarkFixture(
          mock.url,
          payload,
          2,
          5000,
        );

        const stats = computeStats(timingsMs);
        results.push({
          k: fixture.k,
          circuit: fixture.meta?.circuit ?? fixture.name,
          rows: 0, tableRows: 0, hashes: 0, instructions: 0, payloadBytes: 0,
          timingsMs,
          ...stats,
          errors,
        });
      }

      // All fixtures should succeed against mock
      for (const r of results) {
        expect(r.errors).toBe(0);
        expect(r.timingsMs.length).toBe(2);
      }

      const config = resultsToEnvironmentConfig(results, "Test", 60);

      // Validate EnvironmentConfig structure
      expect(config.label).toBe("Test");
      expect(config.maxK).toBe(25); // extrapolated
      // Measured k=10,11,12 + extrapolated 13..25
      expect(config.timings.length).toBe(3 + (25 - 12));

      // First three are measured
      expect(config.timings[0]![0]).toBe(10);
      expect(config.timings[1]![0]).toBe(11);
      expect(config.timings[2]![0]).toBe(12);

      // All timings have [k, low, high] with low <= high
      for (const [k, lo, hi] of config.timings) {
        expect(k).toBeGreaterThanOrEqual(10);
        expect(lo).toBeGreaterThan(0);
        expect(hi).toBeGreaterThanOrEqual(lo);
      }
    },
  );

  it.skipIf(!hasFixtures || !hasZkir)(
    "benchmark EnvironmentConfig integrates with zkir-lint profiler",
    async () => {
      // Simulate a benchmark producing realistic timing data
      const config: EnvironmentConfig = {
        label: "Benchmark Test",
        maxK: 12,
        warnK: 11,
        timings: [
          [10, 0.16, 0.17],
          [11, 0.55, 0.63],
          [12, 0.81, 0.83],
        ],
      };

      // Load a real ZKIR and profile it using the benchmark-generated config
      const zkir = JSON.parse(
        readFileSync(join(ZKIR_DIR, "bench_k12.zkir"), "utf-8"),
      ) as ZkirV2;

      const profile = await profileCircuit(zkir, {
        environments: { "bench-env": config as ProfileEnvConfig },
        targets: ["bench-env"],
      });

      expect(profile.k).toBe(12);
      expect(profile.estimates).toHaveLength(1);

      const est = profile.estimates[0]!;
      expect(est.environment).toBe("bench-env");
      expect(est.feasible).toBe(true);
      // k=12 > warnK=11, so verdict should be "slow"
      expect(est.verdict).toBe("slow");
      // Timing range should come from the k=12 entry
      expect(est.estimatedSeconds[0]).toBe(0.81);
      expect(est.estimatedSeconds[1]).toBe(0.83);
    },
  );
});
