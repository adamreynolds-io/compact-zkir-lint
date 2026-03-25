#!/usr/bin/env node
/**
 * zkir-lint CLI
 *
 * Static analyzer for Compact ZKIR files. Detects JS/ZK divergence patterns
 * where compact-runtime (JS) succeeds but ZKIR preprocessing (proof server) fails.
 *
 * Usage:
 *   zkir-lint [options] <file.zkir> [...]
 *   zkir-lint [options] --recursive <directory>
 *
 * Options:
 *   --format text|json|sarif   Output format (default: text)
 *   --severity error|warn|info Minimum severity to report (default: warn)
 *   --recursive, -r            Scan directories recursively for .zkir files
 *   --stats                    Include circuit statistics in output
 *   --quiet, -q                Only show summary line
 *   --help, -h                 Show this help
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { analyzeFile } from "./analyze.js";
import { exitCode, formatSummary, type Format } from "./format.js";
import type { CircuitReport, Severity, ScanSummary } from "./types.js";

function findZkirFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (stat == null) continue;
    if (stat.isDirectory()) {
      results.push(...findZkirFiles(full));
    } else if (entry.endsWith(".zkir")) {
      results.push(full);
    }
  }
  return results;
}

function usage() {
  console.log(`zkir-lint: Static analyzer for Compact ZKIR files

Detects JS/ZK divergence patterns where compact-runtime succeeds
but ZKIR proof validation fails.

Usage:
  zkir-lint [options] <file.zkir> [...]
  zkir-lint [options] -r <directory>

Options:
  --format text|json|sarif   Output format (default: text)
  --severity error|warn|info Minimum severity to report (default: warn)
  -r, --recursive            Scan directories recursively for .zkir files
  -q, --quiet                Only show summary
  -h, --help                 Show this help

Rules:
  DIV-001  constrain_bits on arithmetic in conditional branch (#226)
  DIV-002  reconstitute_field in conditional branch
  DIV-003  div_mod_power_of_two in conditional branch
  DIV-004  assert on branch-local value
  DIV-005  constrain_eq in conditional branch
  STATS-001  Deep guard nesting (>= 4 levels)
  STATS-002  High constraint density (> 25%)

Examples:
  zkir-lint circuit.zkir
  zkir-lint -r contracts/src/artifacts/
  zkir-lint --format sarif -r . > results.sarif
  zkir-lint --severity error *.zkir`);
}

function main() {
  const args = process.argv.slice(2);
  let format: Format = "text";
  let minSeverity: Severity = "warn";
  let recursive = false;
  let quiet = false;
  const paths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--format":
        format = (args[++i] ?? "text") as Format;
        break;
      case "--severity":
        minSeverity = (args[++i] ?? "warn") as Severity;
        break;
      case "-r":
      case "--recursive":
        recursive = true;
        break;
      case "-q":
      case "--quiet":
        quiet = true;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        paths.push(arg);
    }
  }

  if (paths.length === 0) {
    usage();
    process.exit(1);
  }

  // Collect files
  let files: string[] = [];
  for (const p of paths) {
    const resolved = resolve(p);
    const stat = statSync(resolved, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      if (recursive) {
        files.push(...findZkirFiles(resolved));
      } else {
        console.error(
          `${p} is a directory. Use -r to scan recursively.`,
        );
        process.exit(1);
      }
    } else if (stat?.isFile()) {
      files.push(resolved);
    } else {
      console.error(`Not found: ${p}`);
      process.exit(1);
    }
  }

  files = files.sort();

  if (files.length === 0) {
    console.error("No .zkir files found.");
    process.exit(1);
  }

  // Analyze
  const severityOrder: Record<Severity, number> = {
    error: 3,
    warn: 2,
    info: 1,
  };
  const minSev = severityOrder[minSeverity];

  const reports: CircuitReport[] = [];
  for (const file of files) {
    const report = analyzeFile(file);
    report.findings = report.findings.filter(
      (f) => severityOrder[f.severity] >= minSev,
    );
    reports.push(report);
  }

  const summary: ScanSummary = {
    totalFiles: files.length,
    totalErrors: reports.reduce(
      (sum, r) => sum + r.findings.filter((f) => f.severity === "error").length,
      0,
    ),
    totalWarnings: reports.reduce(
      (sum, r) => sum + r.findings.filter((f) => f.severity === "warn").length,
      0,
    ),
    totalInfos: reports.reduce(
      (sum, r) => sum + r.findings.filter((f) => f.severity === "info").length,
      0,
    ),
    cleanFiles: reports.filter((r) => r.findings.length === 0).length,
    reports: quiet ? [] : reports,
  };

  const output = formatSummary(summary, format);
  console.log(output);
  process.exit(exitCode(summary));
}

main();
