/**
 * Output formatters for zkir-lint results.
 */

import { formatDuration, formatEstimateRange } from "./profile.js";
import type { CircuitReport, ScanSummary } from "./types.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function estimatePayloadBytes(k: number): number {
  return 2 ** k * 48;
}

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

    // Header
    const statusParts = [];
    if (errors.length > 0) statusParts.push(`${errors.length} error(s)`);
    if (warns.length > 0) statusParts.push(`${warns.length} warning(s)`);
    if (infos.length > 0) statusParts.push(`${infos.length} info(s)`);
    const status = statusParts.length > 0 ? statusParts.join(", ") : "clean";

    lines.push(`  ${report.name} (v${report.version}, k=${report.k}): ${status}`);

    // Circuit breakdown — always shown
    const s = report.stats;
    const payload = estimatePayloadBytes(report.k);
    lines.push(
      `    instructions: ${s.totalInstructions}  inputs: ${s.numInputs}  ` +
        `constrain_bits: ${s.constrainBitsCount}  cond_select: ${s.condSelectCount}`,
    );
    lines.push(
      `    guarded regions: ${s.guardedRegions} (max depth ${s.maxGuardDepth})  ` +
        `proof payload: ~${formatBytes(payload)}`,
    );

    // Profile output
    if (report.profile) {
      const p = report.profile;
      const maxKNote = p.maxK != null ? ` | max-k=${p.maxK}` : "";
      lines.push(
        `    k=${p.k} (${p.kSource})${maxKNote} | ` +
          `~${p.rows.toLocaleString()} rows | ` +
          `${p.tableRows.toLocaleString()} table rows | ` +
          `${p.hashCount} hashes (${p.hashRows.toLocaleString()} rows)`,
      );
      for (const est of p.estimates) {
        const env = est.environment.padEnd(14);
        if (!est.feasible) {
          lines.push(`      ${env} infeasible`);
        } else {
          const [lo, hi] = est.estimatedSeconds;
          const secs = `${Math.round(lo)}s-${Math.round(hi)}s`;
          const tag = est.verdict === "slow" ? " SLOW" : "";
          lines.push(`      ${env} ${secs}${tag}`);
        }
      }
    }

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
    {
      id: "PERF-001",
      shortDescription: {
        text: "Circuit exceeds WASM prover limit (k > 15)",
      },
    },
    {
      id: "PERF-002",
      shortDescription: {
        text: "Circuit too large for WASM desktop proving",
      },
    },
    {
      id: "PERF-003",
      shortDescription: { text: "Circuit needs GPU proving" },
    },
    {
      id: "PERF-004",
      shortDescription: { text: "Hash operations dominate circuit" },
    },
    {
      id: "PERF-005",
      shortDescription: { text: "Lookup tables inflate circuit k" },
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
