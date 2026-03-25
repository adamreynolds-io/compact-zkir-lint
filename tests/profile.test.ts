import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { estimateK } from "../src/ir.js";
import {
  profileCircuit,
  formatDuration,
  formatEstimateRange,
} from "../src/profile.js";
import {
  checkWasmKLimit,
  gpuRequired,
  hashDominatedCircuit,
  lookupTableInflation,
} from "../src/rules.js";
import type { ZkirV2, CircuitProfile } from "../src/types.js";

const FIXTURES = join(import.meta.dirname, "fixtures/real");

function loadZkir(name: string): ZkirV2 {
  const raw = readFileSync(join(FIXTURES, name), "utf-8");
  return JSON.parse(raw) as ZkirV2;
}

describe("estimateK", () => {
  it("estimates k for tiny-get.zkir", () => {
    const zkir = loadZkir("tiny-get.zkir");
    const est = estimateK(zkir);
    expect(est.k).toBeGreaterThanOrEqual(6);
    expect(est.k).toBeLessThanOrEqual(12);
    expect(est.rows).toBeGreaterThan(0);
  });

  it("estimates k for micro-dao-advance.zkir", () => {
    const zkir = loadZkir("micro-dao-advance.zkir");
    const est = estimateK(zkir);
    expect(est.k).toBeGreaterThanOrEqual(10);
    expect(est.k).toBeLessThanOrEqual(16);
    expect(est.hashCount).toBeGreaterThan(0);
    expect(est.hashRows).toBe(est.hashCount * 704);
  });

  it("counts hash operations correctly", () => {
    const zkir = loadZkir("micro-dao-cashOut.zkir");
    const est = estimateK(zkir);
    expect(est.hashCount).toBeGreaterThanOrEqual(1);
    expect(est.hashRows).toBe(est.hashCount * 704);
  });

  it("accounts for communications commitment", () => {
    const zkir = loadZkir("tiny-get.zkir");
    const withComm = estimateK({
      ...zkir,
      do_communications_commitment: true,
    });
    const withoutComm = estimateK({
      ...zkir,
      do_communications_commitment: false,
    });
    expect(withComm.rows).toBeGreaterThan(withoutComm.rows);
  });

  it("accepts cost overrides", () => {
    const zkir = loadZkir("micro-dao-advance.zkir");
    const defaultEst = estimateK(zkir);
    const inflated = estimateK(zkir, {
      persistent_hash: { rows: 10000, tableRows: 0 },
    });
    expect(inflated.rows).toBeGreaterThan(defaultEst.rows);
  });
});

describe("profileCircuit", () => {
  it("produces profile for real circuit", async () => {
    const zkir = loadZkir("micro-dao-advance.zkir");
    const profile = await profileCircuit(zkir);
    expect(profile.k).toBeGreaterThan(0);
    expect(profile.kSource).toBe("estimated");
    expect(profile.estimates).toHaveLength(4);
    expect(profile.estimates[0]!.environment).toBe("wasm-mobile");
  });

  it("respects target filter", async () => {
    const zkir = loadZkir("tiny-get.zkir");
    const profile = await profileCircuit(zkir, {
      targets: ["docker", "gpu"],
    });
    expect(profile.estimates).toHaveLength(2);
    expect(profile.estimates[0]!.environment).toBe("docker");
    expect(profile.estimates[1]!.environment).toBe("gpu");
  });

  it("all small circuits are feasible on all targets", async () => {
    const zkir = loadZkir("tiny-get.zkir");
    const profile = await profileCircuit(zkir);
    for (const est of profile.estimates) {
      expect(est.feasible).toBe(true);
      expect(est.verdict).toBe("ok");
    }
  });
});

describe("PERF rules", () => {
  function makeProfile(overrides: Partial<CircuitProfile>): CircuitProfile {
    return {
      k: 10,
      kSource: "estimated",
      rows: 1000,
      tableRows: 0,
      hashCount: 0,
      hashRows: 0,
      ecOpCount: 0,
      ecOpRows: 0,
      estimates: [],
      ...overrides,
    };
  }

  it("PERF-001 fires when k > 15 (WASM hard limit)", () => {
    expect(checkWasmKLimit(15)).toBeNull();
    expect(checkWasmKLimit(16)).not.toBeNull();
    expect(checkWasmKLimit(16)!.rule).toBe("PERF-001");
    expect(checkWasmKLimit(16)!.severity).toBe("warn");
  });

  it("PERF-003 fires when k >= 20", () => {
    expect(gpuRequired(makeProfile({ k: 19 }))).toHaveLength(0);
    expect(gpuRequired(makeProfile({ k: 20 }))).toHaveLength(1);
    expect(gpuRequired(makeProfile({ k: 20 }))[0]!.severity).toBe("info");
  });

  it("PERF-004 fires when hashes dominate", () => {
    expect(
      hashDominatedCircuit(
        makeProfile({ rows: 1000, hashCount: 1, hashRows: 900 }),
      ),
    ).toHaveLength(1);
    expect(
      hashDominatedCircuit(
        makeProfile({ rows: 1000, hashCount: 1, hashRows: 500 }),
      ),
    ).toHaveLength(0);
  });

  it("PERF-005 fires when table rows inflate k", () => {
    expect(
      lookupTableInflation(makeProfile({ k: 17, tableRows: 65536 })),
    ).toHaveLength(1);
    expect(
      lookupTableInflation(makeProfile({ k: 17, tableRows: 100 })),
    ).toHaveLength(0);
  });
});

describe("formatDuration", () => {
  it("formats sub-second", () => {
    expect(formatDuration(0.5)).toBe("<1s");
  });

  it("formats seconds", () => {
    expect(formatDuration(30)).toBe("~30s");
  });

  it("formats minutes", () => {
    expect(formatDuration(120)).toBe("~2min");
  });

  it("formats infeasible", () => {
    expect(formatDuration(Infinity)).toBe("infeasible");
  });
});

describe("formatEstimateRange", () => {
  it("formats infeasible", () => {
    expect(
      formatEstimateRange({
        environment: "wasm-mobile",
        feasible: false,
        estimatedSeconds: [Infinity, Infinity],
        verdict: "infeasible",
      }),
    ).toBe("infeasible");
  });

  it("formats range", () => {
    const result = formatEstimateRange({
      environment: "docker",
      feasible: true,
      estimatedSeconds: [5, 10],
      verdict: "ok",
    });
    expect(result).toContain("5s");
    expect(result).toContain("10s");
  });
});
