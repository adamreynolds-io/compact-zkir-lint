/**
 * Configuration file loader for zkir-lint.
 *
 * Looks for .zkir-lint.json in the current directory or ancestors.
 * CLI flags override config file values.
 *
 * All profiling parameters (environments, timing curves, row costs,
 * thresholds) are configurable here. This avoids embedding
 * hardware-specific estimates in code.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
   *
   * Example:
   * ```json
   * {
   *   "environments": {
   *     "wasm-mobile": {
   *       "label": "Phone (low-end)",
   *       "maxK": 13,
   *       "warnK": 12,
   *       "timings": [[10, 2, 5], [12, 10, 30], [13, 30, 90]]
   *     },
   *     "my-server": {
   *       "label": "Dedicated 32-core",
   *       "maxK": 24,
   *       "warnK": 22,
   *       "timings": [[14, 0.5, 1], [18, 5, 10], [22, 60, 120], [24, 300, 600]]
   *     }
   *   }
   * }
   * ```
   */
  environments?: Record<string, EnvironmentConfig | null>;
  /**
   * Override row costs per ZKIR instruction op.
   * Merged with built-in defaults from Midnight golden files.
   *
   * Example:
   * ```json
   * {
   *   "rowCosts": {
   *     "persistent_hash": { "rows": 800, "tableRows": 2 }
   *   }
   * }
   * ```
   */
  rowCosts?: Record<string, RowCost>;
}

const CONFIG_FILENAME = ".zkir-lint.json";

/**
 * Search for .zkir-lint.json starting from `startDir` and walking up.
 * Returns the parsed config, or an empty object if not found.
 */
export function loadConfig(startDir?: string): LintConfig {
  const dir = resolve(startDir ?? process.cwd());
  const path = findConfigFile(dir);
  if (path == null) return {};

  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as LintConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: failed to parse ${path}: ${msg}`);
    return {};
  }
}

function findConfigFile(dir: string): string | null {
  let current = dir;
  for (let i = 0; i < 20; i++) {
    const candidate = join(current, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
