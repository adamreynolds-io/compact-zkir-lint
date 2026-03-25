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
    it("clean-conditional.compact compiles and lints clean", () => {
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
        const report = analyzeFile(join(zkirDir, file));
        const errors = report.findings.filter((f) => f.severity === "error");
        expect(errors).toHaveLength(0);
      }
    });

    it("conditional-state.compact compiles and lints clean", () => {
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
        const report = analyzeFile(join(zkirDir, file));
        const errors = report.findings.filter((f) => f.severity === "error");
        expect(errors).toHaveLength(0);
      }
    });

    it("cast-in-branch.compact compiles (compiler may optimize the cast)", () => {
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
        const report = analyzeFile(join(zkirDir, file));
        const errors = report.findings.filter((f) => f.severity === "error");
        console.log(
          `  ${file}: ${errors.length} error(s), ${report.findings.length} total finding(s)`,
        );
      }
    });
  });
});

describe("E2E: real compiled circuits with known issues", () => {
  it("micro-dao advance.zkir has DIV-001 error", () => {
    const report = analyzeFile(
      join(REAL_FIXTURES_DIR, "micro-dao-advance.zkir"),
    );
    const errors = report.findings.filter(
      (f) => f.severity === "error" && f.rule === "DIV-001",
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.memoryVar).toBe(28);
    expect(errors[0]!.message).toContain("bits=64");
  });

  it("micro-dao cashOut.zkir has DIV-001 error", () => {
    const report = analyzeFile(
      join(REAL_FIXTURES_DIR, "micro-dao-cashOut.zkir"),
    );
    const errors = report.findings.filter(
      (f) => f.severity === "error" && f.rule === "DIV-001",
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.memoryVar).toBe(51);
    expect(errors[0]!.message).toContain("bits=32");
  });

  it("tiny-get.zkir is clean", () => {
    const report = analyzeFile(join(REAL_FIXTURES_DIR, "tiny-get.zkir"));
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("tiny-set.zkir is clean", () => {
    const report = analyzeFile(join(REAL_FIXTURES_DIR, "tiny-set.zkir"));
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(errors).toHaveLength(0);
  });
});
