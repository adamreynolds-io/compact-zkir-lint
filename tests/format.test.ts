import { describe, it, expect } from "vitest";
import { formatSummary, exitCode } from "../src/format.js";
import type { ScanSummary, CircuitReport } from "../src/types.js";

function makeSummary(overrides: Partial<ScanSummary> = {}): ScanSummary {
  return {
    totalFiles: 1,
    totalErrors: 0,
    totalWarnings: 0,
    totalInfos: 0,
    cleanFiles: 1,
    reports: [],
    ...overrides,
  };
}

function makeReport(overrides: Partial<CircuitReport> = {}): CircuitReport {
  return {
    file: "/test/circuit.zkir",
    name: "circuit",
    version: 2,
    stats: {
      totalInstructions: 10,
      numInputs: 1,
      constrainBitsCount: 2,
      assertCount: 1,
      condSelectCount: 3,
      privateInputCount: 4,
      guardedRegions: 1,
      maxGuardDepth: 1,
      reconstitueFieldCount: 0,
      divModCount: 0,
    },
    findings: [],
    ...overrides,
  };
}

describe("formatSummary: text", () => {
  it("shows clean for circuits with no findings", () => {
    const summary = makeSummary({
      reports: [makeReport()],
    });
    const output = formatSummary(summary, "text");
    expect(output).toContain("clean");
  });

  it("shows ERROR and WARN labels with rule IDs", () => {
    const summary = makeSummary({
      totalErrors: 1,
      totalWarnings: 1,
      cleanFiles: 0,
      reports: [makeReport({
        findings: [
          { severity: "error", rule: "DIV-001", instructionIndex: 5, memoryVar: 3, message: "test error", details: "" },
          { severity: "warn", rule: "DIV-004", instructionIndex: 10, memoryVar: null, message: "test warn", details: "" },
        ],
      })],
    });
    const output = formatSummary(summary, "text");
    expect(output).toContain("ERROR");
    expect(output).toContain("DIV-001");
    expect(output).toContain("WARN");
    expect(output).toContain("DIV-004");
  });

  it("shows correct totals in summary line", () => {
    const summary = makeSummary({
      totalErrors: 3,
      totalWarnings: 7,
      totalInfos: 2,
      cleanFiles: 5,
      totalFiles: 10,
    });
    const output = formatSummary(summary, "text");
    expect(output).toContain("3 error(s)");
    expect(output).toContain("7 warning(s)");
    expect(output).toContain("5/10 clean");
  });
});

describe("formatSummary: json", () => {
  it("produces valid JSON", () => {
    const summary = makeSummary({ reports: [makeReport()] });
    const output = formatSummary(summary, "json");
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("round-trips ScanSummary fields", () => {
    const summary = makeSummary({
      totalErrors: 2,
      totalWarnings: 5,
      totalFiles: 10,
      cleanFiles: 8,
    });
    const output = formatSummary(summary, "json");
    const parsed = JSON.parse(output);
    expect(parsed.totalErrors).toBe(2);
    expect(parsed.totalWarnings).toBe(5);
    expect(parsed.totalFiles).toBe(10);
    expect(parsed.cleanFiles).toBe(8);
  });
});

describe("formatSummary: sarif", () => {
  it("has valid SARIF structure", () => {
    const summary = makeSummary({ reports: [makeReport()] });
    const output = formatSummary(summary, "sarif");
    const sarif = JSON.parse(output);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toContain("sarif-schema");
    expect(sarif.runs[0].tool.driver.name).toBe("zkir-lint");
  });

  it("maps severity correctly", () => {
    const summary = makeSummary({
      totalErrors: 1,
      totalWarnings: 1,
      totalInfos: 1,
      reports: [makeReport({
        findings: [
          { severity: "error", rule: "DIV-001", instructionIndex: 0, memoryVar: 0, message: "", details: "" },
          { severity: "warn", rule: "DIV-004", instructionIndex: 1, memoryVar: null, message: "", details: "" },
          { severity: "info", rule: "STATS-001", instructionIndex: 2, memoryVar: null, message: "", details: "" },
        ],
      })],
    });
    const sarif = JSON.parse(formatSummary(summary, "sarif"));
    const levels = sarif.runs[0].results.map((r: { level: string }) => r.level);
    expect(levels).toContain("error");
    expect(levels).toContain("warning");
    expect(levels).toContain("note");
  });

  it("includes all rule IDs", () => {
    const summary = makeSummary();
    const sarif = JSON.parse(formatSummary(summary, "sarif"));
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    expect(ruleIds).toContain("DIV-001");
    expect(ruleIds).toContain("DIV-002");
    expect(ruleIds).toContain("DIV-003");
    expect(ruleIds).toContain("DIV-004");
    expect(ruleIds).toContain("DIV-005");
    expect(ruleIds).toContain("STATS-001");
    expect(ruleIds).toContain("STATS-002");
  });
});

describe("exitCode", () => {
  it("returns 1 when errors exist", () => {
    expect(exitCode(makeSummary({ totalErrors: 1 }))).toBe(1);
  });

  it("returns 0 when only warnings", () => {
    expect(exitCode(makeSummary({ totalWarnings: 5, totalErrors: 0 }))).toBe(0);
  });

  it("returns 0 when clean", () => {
    expect(exitCode(makeSummary())).toBe(0);
  });
});
