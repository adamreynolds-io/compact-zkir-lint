/**
 * Output formatters for zkir-lint results.
 */

import type { CircuitReport, ScanSummary } from "./types.js";

export type Format = "text" | "json" | "sarif";

export function formatSummary(summary: ScanSummary, format: Format): string {
  switch (format) {
    case "json":
      return JSON.stringify(summary, null, 2);
    case "sarif":
      return formatSarif(summary);
    case "text":
      return formatText(summary);
  }
}

function formatText(summary: ScanSummary): string {
  const lines: string[] = [];

  lines.push(
    `zkir-lint: scanned ${summary.totalFiles} file(s)\n`,
  );

  for (const report of summary.reports) {
    const errors = report.findings.filter((f) => f.severity === "error");
    const warns = report.findings.filter((f) => f.severity === "warn");
    const infos = report.findings.filter((f) => f.severity === "info");

    if (report.findings.length === 0) {
      lines.push(`  ${report.name} (v${report.version}): clean`);
      continue;
    }

    const parts = [];
    if (errors.length > 0) parts.push(`${errors.length} error(s)`);
    if (warns.length > 0) parts.push(`${warns.length} warning(s)`);
    if (infos.length > 0) parts.push(`${infos.length} info(s)`);

    lines.push(`  ${report.name} (v${report.version}): ${parts.join(", ")}`);

    // Stats line
    const s = report.stats;
    lines.push(
      `    ${s.totalInstructions} instructions, ${s.numInputs} inputs, ` +
        `${s.constrainBitsCount} constrain_bits, ${s.condSelectCount} cond_select, ` +
        `${s.guardedRegions} guarded regions (max depth ${s.maxGuardDepth})`,
    );

    // Findings
    for (const f of report.findings) {
      const icon =
        f.severity === "error"
          ? "ERROR"
          : f.severity === "warn"
            ? "WARN "
            : "INFO ";
      lines.push(
        `    ${icon} [${f.rule}] inst ${f.instructionIndex}: ${f.message}`,
      );
    }

    lines.push("");
  }

  lines.push(
    `${summary.totalErrors} error(s), ${summary.totalWarnings} warning(s), ` +
      `${summary.totalInfos} info(s) | ${summary.cleanFiles}/${summary.totalFiles} clean`,
  );

  return lines.join("\n");
}

function formatSarif(summary: ScanSummary): string {
  const rules = [
    {
      id: "DIV-001",
      shortDescription: {
        text: "Unconditional constrain_bits on arithmetic in guarded region",
      },
      helpUri:
        "https://github.com/LFDT-Minokawa/compact/issues/226",
    },
    {
      id: "DIV-002",
      shortDescription: {
        text: "reconstitute_field in guarded region",
      },
    },
    {
      id: "DIV-003",
      shortDescription: {
        text: "div_mod_power_of_two in guarded region",
      },
    },
    {
      id: "DIV-004",
      shortDescription: {
        text: "assert on branch-local value",
      },
    },
    {
      id: "DIV-005",
      shortDescription: {
        text: "constrain_eq in guarded region",
      },
    },
    {
      id: "STATS-001",
      shortDescription: { text: "Deep guard nesting" },
    },
    {
      id: "STATS-002",
      shortDescription: { text: "High constraint density" },
    },
  ];

  const results: object[] = [];
  for (const report of summary.reports) {
    for (const f of report.findings) {
      results.push({
        ruleId: f.rule,
        level:
          f.severity === "error"
            ? "error"
            : f.severity === "warn"
              ? "warning"
              : "note",
        message: { text: f.message },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: report.file },
              region: {
                startLine: f.instructionIndex + 1,
              },
            },
          },
        ],
        properties: {
          memoryVar: f.memoryVar,
          details: f.details,
        },
      });
    }
  }

  const sarif = {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "zkir-lint",
            version: "0.1.0",
            informationUri: "https://github.com/LFDT-Minokawa/compact/issues/226",
            rules,
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

export function exitCode(summary: ScanSummary): number {
  if (summary.totalErrors > 0) return 1;
  return 0;
}
