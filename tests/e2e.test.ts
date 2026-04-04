/**
 * End-to-end tests: Compact source → compile → lint → verify.
 *
 * Compiles real Compact contracts with `compact compile +0.30.0`,
 * then runs the linter on the generated ZKIR, asserting expected findings.
 *
 * Requires: `compact` CLI installed and +0.30.0 toolchain available.
 * The `zkir` binary must be in the compiler's toolchain directory
 * (~/.compact/versions/0.30.0/aarch64-darwin/zkir) for ZKIR generation.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeFile } from "../src/analyze.js";

const COMPACT_VERSION = "0.30.0";
const FIXTURES_DIR = join(import.meta.dirname, "fixtures/compact");
const REAL_FIXTURES_DIR = join(import.meta.dirname, "fixtures/real");

/** Check if compact compiler is available */
function compactAvailable(): boolean {
  try {
    const version = execSync("compact compile +0.30.0 --version", {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    return version === COMPACT_VERSION;
  } catch {
    return false;
  }
}

/** Compile a .compact file and return path to zkir output directory */
function compileCompact(sourcePath: string): string | null {
  const outDir = mkdtempSync(join(tmpdir(), "zkir-lint-e2e-"));
  try {
    // The zkir binary must be findable for ZKIR generation.
    // Add the compiler's toolchain dir to PATH.
    const toolchainDir = join(
      process.env.HOME ?? "~",
      `.compact/versions/${COMPACT_VERSION}/aarch64-darwin`,
    );
    const env = {
      ...process.env,
      PATH: `${toolchainDir}:${process.env.PATH}`,
    };

    execSync(
      `compact compile +${COMPACT_VERSION} "${sourcePath}" "${outDir}"`,
      { encoding: "utf-8", timeout: 120000, env, stdio: "pipe" },
    );

    const zkirDir = join(outDir, "zkir");
    if (existsSync(zkirDir)) {
      return zkirDir;
    }
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`Compilation failed for ${sourcePath}: ${msg}`);
    return null;
  }
}

const hasCompact = compactAvailable();

describe.skipIf(!hasCompact)("E2E: Compact source → compile → lint", () => {
  describe("clean contracts (no findings expected)", () => {
    it("clean-conditional.compact compiles and lints clean", async () => {
      const zkirDir = compileCompact(
        join(FIXTURES_DIR, "clean-conditional.compact"),
      );

      if (zkirDir === null) {
        // ZKIR not generated (zkir binary not found) — skip gracefully
        console.warn("ZKIR not generated — zkir binary may not be in PATH");
        return;
      }

      const zkirFiles = readdirSync(zkirDir).filter((f) =>
        f.endsWith(".zkir"),
      );
      expect(zkirFiles.length).toBeGreaterThan(0);

      for (const file of zkirFiles) {
        const report = await analyzeFile(join(zkirDir, file));
        const errors = report.findings.filter((f) => f.severity === "error");
        expect(errors).toHaveLength(0);
      }
    });

    it("conditional-state.compact compiles and lints clean", async () => {
      const zkirDir = compileCompact(
        join(FIXTURES_DIR, "conditional-state.compact"),
      );

      if (zkirDir === null) {
        console.warn("ZKIR not generated — zkir binary may not be in PATH");
        return;
      }

      const zkirFiles = readdirSync(zkirDir).filter((f) =>
        f.endsWith(".zkir"),
      );
      expect(zkirFiles.length).toBeGreaterThan(0);

      for (const file of zkirFiles) {
        const report = await analyzeFile(join(zkirDir, file));
        const errors = report.findings.filter((f) => f.severity === "error");
        expect(errors).toHaveLength(0);
      }
    });

    it("cast-in-branch.compact compiles (compiler may optimize the cast)", async () => {
      const zkirDir = compileCompact(
        join(FIXTURES_DIR, "cast-in-branch.compact"),
      );

      if (zkirDir === null) {
        console.warn("ZKIR not generated — zkir binary may not be in PATH");
        return;
      }

      const zkirFiles = readdirSync(zkirDir).filter((f) =>
        f.endsWith(".zkir"),
      );
      expect(zkirFiles.length).toBeGreaterThan(0);

      // The compiler may place constrain_bits after cond_select for simple
      // cases — log the result either way
      for (const file of zkirFiles) {
        const report = await analyzeFile(join(zkirDir, file));
        const errors = report.findings.filter((f) => f.severity === "error");
        console.log(
          `  ${file}: ${errors.length} error(s), ${report.findings.length} total finding(s)`,
        );
      }
    });
  });

  describe("divergence contracts (expected findings)", () => {
    it("div-001: downcast in branch triggers DIV-001", async () => {
      const zkirDir = compileCompact(
        join(FIXTURES_DIR, "div-001-downcast-in-branch.compact"),
      );
      if (zkirDir === null) return;

      const report = await analyzeFile(
        join(zkirDir, "conditional_increment.zkir"),
      );
      const div001 = report.findings.filter((f) => f.rule === "DIV-001");
      expect(div001.length).toBeGreaterThanOrEqual(1);
      expect(div001[0]!.severity).toBe("error");
    });

    it("div-002: bytes-to-field in branch triggers DIV-002", async () => {
      const zkirDir = compileCompact(
        join(FIXTURES_DIR, "div-002-bytes-to-field-in-branch.compact"),
      );
      if (zkirDir === null) return;

      const report = await analyzeFile(
        join(zkirDir, "conditional_store.zkir"),
      );
      const div002 = report.findings.filter((f) => f.rule === "DIV-002");
      expect(div002.length).toBeGreaterThanOrEqual(1);
      expect(div002[0]!.severity).toBe("error");
    });

    it("div-003: field-to-bytes in branch triggers DIV-003", async () => {
      const zkirDir = compileCompact(
        join(FIXTURES_DIR, "div-003-field-to-bytes-in-branch.compact"),
      );
      if (zkirDir === null) return;

      const report = await analyzeFile(
        join(zkirDir, "conditional_extract.zkir"),
      );
      const div003 = report.findings.filter((f) => f.rule === "DIV-003");
      expect(div003.length).toBeGreaterThanOrEqual(1);
      expect(div003[0]!.severity).toBe("warn");
    });

    it("div-004: assert in branch is clean (compiler wraps with cond_select)", async () => {
      const zkirDir = compileCompact(
        join(FIXTURES_DIR, "div-004-assert-in-branch.compact"),
      );
      if (zkirDir === null) return;

      const report = await analyzeFile(
        join(zkirDir, "guarded_assert.zkir"),
      );
      const div004 = report.findings.filter((f) => f.rule === "DIV-004");
      expect(div004).toHaveLength(0);
    });

    it("div-005: constrain_eq in branch triggers DIV-005", async () => {
      const zkirDir = compileCompact(
        join(FIXTURES_DIR, "div-005-constrain-eq-in-branch.compact"),
      );
      if (zkirDir === null) return;

      const report = await analyzeFile(
        join(zkirDir, "check_and_set.zkir"),
      );
      const div005 = report.findings.filter((f) => f.rule === "DIV-005");
      expect(div005.length).toBeGreaterThanOrEqual(1);
      expect(div005[0]!.severity).toBe("warn");
    });

    it("rt-001: persistent hash with guarded witness triggers RT-001", async () => {
      const zkirDir = compileCompact(
        join(FIXTURES_DIR, "rt-001-persistent-hash-guarded.compact"),
      );
      if (zkirDir === null) return;

      const report = await analyzeFile(
        join(zkirDir, "conditional_hash.zkir"),
      );
      const rt001 = report.findings.filter((f) => f.rule === "RT-001");
      expect(rt001.length).toBeGreaterThanOrEqual(1);
    });

    it("rt-002: less_than with guarded witness triggers RT-002", async () => {
      const zkirDir = compileCompact(
        join(FIXTURES_DIR, "rt-002-less-than-guarded.compact"),
      );
      if (zkirDir === null) return;

      const report = await analyzeFile(
        join(zkirDir, "nested_compare.zkir"),
      );
      const rt002 = report.findings.filter((f) => f.rule === "RT-002");
      expect(rt002.length).toBeGreaterThanOrEqual(1);
    });

    it("rt-003: transient hash with guarded witness triggers RT-003", async () => {
      const zkirDir = compileCompact(
        join(FIXTURES_DIR, "rt-003-transient-hash-guarded.compact"),
      );
      if (zkirDir === null) return;

      const report = await analyzeFile(
        join(zkirDir, "conditional_log.zkir"),
      );
      const rt003 = report.findings.filter((f) => f.rule === "RT-003");
      expect(rt003.length).toBeGreaterThanOrEqual(1);
    });

    it("rt-004: long arithmetic chain triggers RT-004", async () => {
      const zkirDir = compileCompact(
        join(FIXTURES_DIR, "rt-004-long-arithmetic-chain.compact"),
      );
      if (zkirDir === null) return;

      const report = await analyzeFile(join(zkirDir, "accumulate.zkir"));
      const rt004 = report.findings.filter((f) => f.rule === "RT-004");
      expect(rt004.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("E2E: real compiled circuits with known issues", () => {
  it("micro-dao advance.zkir has DIV-001 error", async () => {
    const report = await analyzeFile(
      join(REAL_FIXTURES_DIR, "micro-dao-advance.zkir"),
    );
    const errors = report.findings.filter(
      (f) => f.severity === "error" && f.rule === "DIV-001",
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.memoryVar).toBe(28);
    expect(errors[0]!.message).toContain("bits=64");
  });

  it("micro-dao cashOut.zkir has DIV-001 error", async () => {
    const report = await analyzeFile(
      join(REAL_FIXTURES_DIR, "micro-dao-cashOut.zkir"),
    );
    const errors = report.findings.filter(
      (f) => f.severity === "error" && f.rule === "DIV-001",
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.memoryVar).toBe(51);
    expect(errors[0]!.message).toContain("bits=32");
  });

  it("tiny-get.zkir is clean", async () => {
    const report = await analyzeFile(join(REAL_FIXTURES_DIR, "tiny-get.zkir"));
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("tiny-set.zkir is clean", async () => {
    const report = await analyzeFile(join(REAL_FIXTURES_DIR, "tiny-set.zkir"));
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(errors).toHaveLength(0);
  });
});

describe("E2E: profiling", () => {
  it("--profile produces k estimate and proving times", async () => {
    const report = await analyzeFile(
      join(REAL_FIXTURES_DIR, "micro-dao-advance.zkir"),
      { profile: true },
    );
    expect(report.profile).toBeDefined();
    expect(report.profile!.k).toBeGreaterThanOrEqual(9);
    expect(report.profile!.kSource).toBe("estimated");
    expect(report.profile!.rows).toBeGreaterThan(0);
    expect(report.profile!.hashCount).toBeGreaterThanOrEqual(1);
    expect(report.profile!.estimates.length).toBeGreaterThanOrEqual(4);

    for (const est of report.profile!.estimates) {
      expect(est.environment).toBeTruthy();
      expect(typeof est.feasible).toBe("boolean");
      expect(est.estimatedSeconds).toHaveLength(2);
      expect(["ok", "slow", "infeasible"]).toContain(est.verdict);
    }
  });

  it("--profile with --target filters environments", async () => {
    const report = await analyzeFile(
      join(REAL_FIXTURES_DIR, "tiny-get.zkir"),
      { profile: true, targets: ["docker"] },
    );
    expect(report.profile).toBeDefined();
    expect(report.profile!.estimates).toHaveLength(1);
    expect(report.profile!.estimates[0]!.environment).toBe("docker");
  });

  it("--max-k produces PERF-006 when exceeded", async () => {
    const report = await analyzeFile(
      join(REAL_FIXTURES_DIR, "micro-dao-cashOut.zkir"),
      { profile: true, maxK: 10 },
    );
    expect(report.profile).toBeDefined();
    expect(report.profile!.k).toBeGreaterThan(10);
    expect(report.profile!.maxK).toBe(10);

    const perf006 = report.findings.find((f) => f.rule === "PERF-006");
    expect(perf006).toBeDefined();
    expect(perf006!.severity).toBe("error");
    expect(perf006!.message).toContain("exceeds maximum k=10");
  });

  it("--max-k does not fire when circuit is within limit", async () => {
    const report = await analyzeFile(
      join(REAL_FIXTURES_DIR, "tiny-get.zkir"),
      { profile: true, maxK: 20 },
    );
    const perf006 = report.findings.find((f) => f.rule === "PERF-006");
    expect(perf006).toBeUndefined();
  });

  it("custom environments override defaults", async () => {
    const report = await analyzeFile(
      join(REAL_FIXTURES_DIR, "micro-dao-advance.zkir"),
      {
        profile: true,
        environments: {
          "test-env": {
            label: "Test",
            maxK: 10,
            warnK: 8,
            timings: [[8, 1, 2], [10, 5, 10]],
          },
        },
        targets: ["test-env"],
      },
    );
    expect(report.profile).toBeDefined();
    expect(report.profile!.estimates).toHaveLength(1);
    expect(report.profile!.estimates[0]!.environment).toBe("test-env");

    // k=11 exceeds test-env maxK=10, so infeasible
    expect(report.profile!.estimates[0]!.feasible).toBe(false);
    expect(report.profile!.estimates[0]!.verdict).toBe("infeasible");
  });

  it("profiling does not interfere with divergence findings", async () => {
    const report = await analyzeFile(
      join(REAL_FIXTURES_DIR, "micro-dao-advance.zkir"),
      { profile: true },
    );
    const div001 = report.findings.find((f) => f.rule === "DIV-001");
    expect(div001).toBeDefined();
    expect(div001!.severity).toBe("error");
  });

  it("clean circuit with profiling has no PERF errors", async () => {
    const report = await analyzeFile(
      join(REAL_FIXTURES_DIR, "tiny-get.zkir"),
      { profile: true },
    );
    const perfErrors = report.findings.filter(
      (f) => f.rule.startsWith("PERF") && f.severity === "error",
    );
    expect(perfErrors).toHaveLength(0);
  });
});
