/**
 * Profile configuration loader for zkir-lint.
 *
 * Loads profiling parameters (environments, timing curves, row costs,
 * thresholds) from a JSON file specified via --profile-config.
 * Generate one with: npx tsx bench/benchmark.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { EnvironmentConfig } from "./profile.js";
import type { RowCost } from "./types.js";

export interface LintConfig {
  /** Maximum acceptable k value. Circuits exceeding this produce an error. */
  maxK?: number;
  /** Proving targets to evaluate (keys into environments map). */
  targets?: string[];
  /** Minimum severity to report: error, warn, info (default: warn). */
  severity?: "error" | "warn" | "info";
  /** Enable profiling by default. */
  profile?: boolean;
  /**
   * Override or add proving environments. Each key is an environment name.
   * Merged with built-in defaults (wasm-mobile, wasm-desktop, docker, gpu).
   * Set an environment to null to remove a built-in.
   */
  environments?: Record<string, EnvironmentConfig | null>;
  /**
   * Override row costs per ZKIR instruction op.
   * Merged with built-in defaults from Midnight golden files.
   */
  rowCosts?: Record<string, RowCost>;
}

function isEnvironmentConfig(v: unknown): v is EnvironmentConfig {
  if (typeof v !== "object" || v == null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.label === "string" &&
    typeof o.maxK === "number" &&
    typeof o.warnK === "number" &&
    Array.isArray(o.timings) &&
    o.timings.every(
      (t: unknown) =>
        Array.isArray(t) &&
        t.length === 3 &&
        t.every((n: unknown) => typeof n === "number"),
    )
  );
}

function validateConfig(data: unknown, path: string): LintConfig {
  if (typeof data !== "object" || data == null || Array.isArray(data)) {
    throw new Error(`${path}: config must be a JSON object`);
  }

  const obj = data as Record<string, unknown>;
  const config: LintConfig = {};

  if ("maxK" in obj) {
    if (typeof obj.maxK !== "number" || obj.maxK < 1 || obj.maxK > 30) {
      throw new Error(`${path}: maxK must be 1-30`);
    }
    config.maxK = obj.maxK;
  }

  if ("targets" in obj) {
    if (
      !Array.isArray(obj.targets) ||
      !obj.targets.every((t: unknown) => typeof t === "string")
    ) {
      throw new Error(`${path}: targets must be string[]`);
    }
    config.targets = obj.targets as string[];
  }

  if ("severity" in obj) {
    if (!["error", "warn", "info"].includes(obj.severity as string)) {
      throw new Error(`${path}: severity must be error|warn|info`);
    }
    config.severity = obj.severity as LintConfig["severity"];
  }

  if ("profile" in obj) {
    if (typeof obj.profile !== "boolean") {
      throw new Error(`${path}: profile must be boolean`);
    }
    config.profile = obj.profile;
  }

  if ("environments" in obj) {
    if (typeof obj.environments !== "object" || obj.environments == null) {
      throw new Error(`${path}: environments must be an object`);
    }
    const envs: Record<string, EnvironmentConfig | null> = {};
    for (const [name, value] of Object.entries(
      obj.environments as Record<string, unknown>,
    )) {
      if (name === "__proto__" || name === "constructor") continue;
      if (value === null) {
        envs[name] = null;
      } else if (isEnvironmentConfig(value)) {
        envs[name] = value;
      } else {
        throw new Error(
          `${path}: environments.${name} must be an EnvironmentConfig or null`,
        );
      }
    }
    config.environments = envs;
  }

  if ("rowCosts" in obj) {
    if (typeof obj.rowCosts !== "object" || obj.rowCosts == null) {
      throw new Error(`${path}: rowCosts must be an object`);
    }
    const costs: Record<string, RowCost> = {};
    for (const [name, value] of Object.entries(
      obj.rowCosts as Record<string, unknown>,
    )) {
      if (name === "__proto__" || name === "constructor") continue;
      const v = value as Record<string, unknown>;
      if (typeof v?.rows !== "number" || typeof v?.tableRows !== "number") {
        throw new Error(
          `${path}: rowCosts.${name} must have numeric rows and tableRows`,
        );
      }
      costs[name] = { rows: v.rows, tableRows: v.tableRows };
    }
    config.rowCosts = costs;
  }

  return config;
}

/**
 * Load a profile config from an explicit file path.
 * Returns an empty object if no path is given.
 */
export function loadConfig(configPath?: string): LintConfig {
  if (configPath == null) return {};

  const resolved = resolve(configPath);
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to read profile config ${resolved}: ${msg}`);
    process.exit(1);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Invalid JSON in ${resolved}: ${msg}`);
    process.exit(1);
  }

  try {
    return validateConfig(data, resolved);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  }
}
