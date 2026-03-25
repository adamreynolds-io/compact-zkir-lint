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
 *   --profile                  Enable circuit performance profiling
 *   --target <env>             Proving target: wasm-mobile|wasm-desktop|docker|gpu (default: all)
 *   --k-source estimate|wasm   K estimation method (default: auto)
 *   --quiet, -q                Only show summary line
 *   --help, -h                 Show this help
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { analyzeFile, type AnalyzeOptions } from "./analyze.js";
import { loadConfig } from "./config.js";
import { exitCode, formatSummary, type Format } from "./format.js";
import type {
  CircuitReport,
  ProvingTarget,
  Severity,
  ScanSummary,
} from "./types.js";

function findZkirFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (
      entry === "node_modules" ||
      entry === ".git" ||
      entry.startsWith(".")
    ) {
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

const VALID_TARGETS = new Set([
  "wasm-mobile",
  "wasm-desktop",
  "docker",
  "gpu",
]);

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
  --profile                  Enable circuit performance profiling
  --profile-config <path>    Load profiling config (environments, timings)
  --max-k <number>           Maximum acceptable k value (error if exceeded)
  --target <env>             Proving target (repeatable): wasm-mobile,
                             wasm-desktop, docker, gpu (default: all)
  --k-source estimate|wasm   K estimation method (default: auto-detect)
  -q, --quiet                Only show summary
  -h, --help                 Show this help

Rules:
  DIV-001    constrain_bits in conditional branch (#226)
  DIV-002    reconstitute_field in conditional branch
  DIV-003    div_mod_power_of_two in conditional branch
  DIV-004    assert on branch-local value
  DIV-005    constrain_eq in conditional branch
  RT-001     persistent_hash with guarded inputs
  RT-002     less_than with guarded operands
  RT-003     transient_hash with guarded inputs
  RT-004     deep arithmetic chain
  STATS-001  Deep guard nesting (>= 4 levels)
  STATS-002  High constraint density (> 25%)
  PERF-001   Circuit exceeds WASM prover limit (k > 15)
  PERF-003   Circuit needs GPU proving (k >= 20)
  PERF-004   Hash operations dominate circuit size
  PERF-005   Lookup tables inflate circuit k
  PERF-006   Circuit exceeds --max-k limit

Examples:
  zkir-lint circuit.zkir
  zkir-lint -r contracts/src/artifacts/
  zkir-lint --profile -r contracts/src/artifacts/
  zkir-lint --profile --profile-config my-profile.json *.zkir
  zkir-lint --profile --max-k 14 -r contracts/src/artifacts/
  zkir-lint --format sarif -r . > results.sarif`);
}

async function main() {
  const args = process.argv.slice(2);
  let format: Format = "text";
  let minSeverity: Severity = "warn";
  let recursive = false;
  let quiet = false;
  let profile = false;
  let maxK: number | undefined;
  const targets: ProvingTarget[] = [];
  let kSource: "estimate" | "wasm" | "auto" = "auto";
  let profileConfigPath: string | undefined;
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
      case "--profile":
        profile = true;
        break;
      case "--profile-config":
        profileConfigPath = args[++i];
        profile = true;
        break;
      case "--max-k": {
        const val = Number(args[++i]);
        if (!Number.isInteger(val) || val < 1 || val > 25) {
          console.error(
            `Invalid --max-k: must be an integer between 1 and 25`,
          );
          process.exit(1);
        }
        maxK = val;
        profile = true;
        break;
      }
      case "--target": {
        const t = args[++i] ?? "";
        if (!VALID_TARGETS.has(t)) {
          console.error(
            `Invalid target: ${t}. ` +
              `Valid: wasm-mobile, wasm-desktop, docker, gpu`,
          );
          process.exit(1);
        }
        targets.push(t as ProvingTarget);
        break;
      }
      case "--k-source": {
        const ks = args[++i] ?? "";
        if (ks !== "estimate" && ks !== "wasm") {
          console.error(
            `Invalid k-source: ${ks}. Valid: estimate, wasm`,
          );
          process.exit(1);
        }
        kSource = ks;
        break;
      }
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

  // Load profile config if specified — CLI flags override config values
  const config = loadConfig(profileConfigPath);
  if (config.maxK != null && maxK == null) maxK = config.maxK;
  if (config.profile && !profile) profile = config.profile;
  if (config.targets && targets.length === 0) {
    targets.push(...config.targets);
  }
  if (config.severity && minSeverity === "warn") {
    minSeverity = config.severity;
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

  // Resolve environments: config can override or add custom environments.
  // Null values in config remove built-in environments.
  let environments: Record<string, import("./profile.js").EnvironmentConfig> | undefined;
  if (config.environments) {
    const { DEFAULT_ENVIRONMENTS } = await import("./profile.js");
    environments = { ...DEFAULT_ENVIRONMENTS };
    for (const [name, env] of Object.entries(config.environments)) {
      if (env == null) {
        delete environments[name];
      } else {
        environments[name] = env;
      }
    }
  }

  const analyzeOpts: AnalyzeOptions = {
    profile,
    targets: targets.length > 0 ? targets : undefined,
    kSource,
    maxK,
    environments,
    rowCosts: config.rowCosts,
  };

  const reports: CircuitReport[] = [];
  for (const file of files) {
    const report = await analyzeFile(file, analyzeOpts);
    report.findings = report.findings.filter(
      (f) => severityOrder[f.severity] >= minSev,
    );
    reports.push(report);
  }

  const summary: ScanSummary = {
    totalFiles: files.length,
    totalErrors: reports.reduce(
      (sum, r) =>
        sum + r.findings.filter((f) => f.severity === "error").length,
      0,
    ),
    totalWarnings: reports.reduce(
      (sum, r) =>
        sum + r.findings.filter((f) => f.severity === "warn").length,
      0,
    ),
    totalInfos: reports.reduce(
      (sum, r) =>
        sum + r.findings.filter((f) => f.severity === "info").length,
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
