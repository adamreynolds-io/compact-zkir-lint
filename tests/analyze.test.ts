import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { analyzeFile } from "../src/analyze.js";

const FIXTURES = join(import.meta.dirname, "fixtures/real");

describe("analyzeFile", () => {
  it("reports tiny-get.zkir as clean", async () => {
    const report = await analyzeFile(join(FIXTURES, "tiny-get.zkir"));
    expect(report.name).toBe("tiny-get");
    expect(report.version).toBe(2);
    const errors = report.findings.filter(f => f.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("reports correct stats for tiny-set.zkir", async () => {
    const report = await analyzeFile(join(FIXTURES, "tiny-set.zkir"));
    expect(report.name).toBe("tiny-set");
    expect(report.stats.numInputs).toBe(1);
    expect(report.stats.constrainBitsCount).toBeGreaterThanOrEqual(2);
    const errors = report.findings.filter(f => f.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("finds DIV-001 in micro-dao-advance.zkir", async () => {
    const report = await analyzeFile(join(FIXTURES, "micro-dao-advance.zkir"));
    const errors = report.findings.filter(f => f.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const div001 = errors.find(f => f.rule === "DIV-001");
    expect(div001).toBeDefined();
    expect(div001!.memoryVar).toBe(28);
  });

  it("finds DIV-001 in micro-dao-cashOut.zkir", async () => {
    const report = await analyzeFile(join(FIXTURES, "micro-dao-cashOut.zkir"));
    const errors = report.findings.filter(f => f.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const div001 = errors.find(f => f.rule === "DIV-001");
    expect(div001).toBeDefined();
    expect(div001!.memoryVar).toBe(51);
  });

  it("returns PARSE warning for unsupported version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zkir-lint-test-"));
    const file = join(dir, "bad.zkir");
    writeFileSync(file, JSON.stringify({
      version: { major: 99, minor: 0 },
      instructions: [],
    }));
    try {
      const report = await analyzeFile(file);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]!.rule).toBe("PARSE");
      expect(report.findings[0]!.severity).toBe("warn");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("produces complete CircuitReport structure", async () => {
    const report = await analyzeFile(join(FIXTURES, "tiny-get.zkir"));
    expect(report).toHaveProperty("file");
    expect(report).toHaveProperty("name");
    expect(report).toHaveProperty("version");
    expect(report).toHaveProperty("stats");
    expect(report).toHaveProperty("findings");
    expect(report.stats).toHaveProperty("totalInstructions");
    expect(report.stats).toHaveProperty("numInputs");
    expect(report.stats).toHaveProperty("constrainBitsCount");
    expect(report.stats).toHaveProperty("assertCount");
    expect(report.stats).toHaveProperty("condSelectCount");
    expect(report.stats).toHaveProperty("guardedRegions");
    expect(report.stats).toHaveProperty("maxGuardDepth");
  });
});
