/**
 * Circuit performance profiler.
 *
 * Estimates proving time across environments based on circuit k-value.
 * All parameters (environment models, timing curves, thresholds) are
 * data-driven — loaded from config, with built-in defaults.
 */

import { estimateK } from "./ir.js";
import type {
  CircuitProfile,
  KSource,
  ProvingEstimate,
  RowCost,
  ZkirV2,
  ZkirV3,
} from "./types.js";

/**
 * A proving time entry: [maxK, lowSeconds, highSeconds].
 * For a given k, find the first entry where k <= maxK.
 * If no entry matches, the environment is infeasible at that k.
 */
export type TimingEntry = [number, number, number];

/**
 * Data-driven environment model. All fields are JSON-serializable
 * so they can live in .zkir-lint.json.
 */
export interface EnvironmentConfig {
  label: string;
  maxK: number;
  warnK: number;
  /** Sorted by maxK ascending. Each entry: [maxK, lowSec, highSec]. */
  timings: TimingEntry[];
}

/** Built-in environment defaults. */
export const DEFAULT_ENVIRONMENTS: Record<string, EnvironmentConfig> = {
  "wasm-mobile": {
    label: "WASM mobile",
    maxK: 15,
    warnK: 13,
    timings: [
      [10, 1, 3],
      [12, 5, 15],
      [13, 15, 40],
      [14, 40, 90],
      [15, 90, 240],
    ],
  },
  "wasm-desktop": {
    label: "WASM desktop",
    maxK: 17,
    warnK: 15,
    timings: [
      [10, 0.5, 1],
      [12, 2, 5],
      [14, 8, 20],
      [15, 20, 50],
      [16, 50, 120],
      [17, 120, 300],
    ],
  },
  docker: {
    label: "Docker (8-core)",
    maxK: 22,
    warnK: 20,
    timings: [
      [12, 0.5, 2],
      [14, 2, 5],
      [16, 5, 15],
      [18, 30, 60],
      [20, 60, 180],
      [22, 300, 600],
    ],
  },
  gpu: {
    label: "GPU service",
    maxK: 25,
    warnK: 23,
    timings: [
      [14, 0.5, 2],
      [16, 2, 5],
      [18, 8, 20],
      [20, 30, 60],
      [22, 60, 180],
      [24, 300, 600],
      [25, 600, 1200],
    ],
  },
};

function secondsAtK(
  timings: TimingEntry[],
  k: number,
): [number, number] {
  for (const [maxK, lo, hi] of timings) {
    if (k <= maxK) return [lo, hi];
  }
  return [Infinity, Infinity];
}

function estimateForEnvironment(
  k: number,
  envName: string,
  env: EnvironmentConfig,
): ProvingEstimate {
  const feasible = k <= env.maxK;
  const estimatedSeconds = feasible
    ? secondsAtK(env.timings, k)
    : ([Infinity, Infinity] as [number, number]);

  let verdict: ProvingEstimate["verdict"];
  if (!feasible) {
    verdict = "infeasible";
  } else if (k > env.warnK) {
    verdict = "slow";
  } else {
    verdict = "ok";
  }

  return { environment: envName, feasible, estimatedSeconds, verdict };
}

/**
 * Try to get exact k from WASM module (optional dependency).
 * Returns null if @midnight-ntwrk/zkir-v2 is not installed.
 */
async function tryWasmK(rawJson: string): Promise<number | null> {
  try {
    const mod: {
      Zkir: { fromJson(json: string): { getK(): number } };
    } = await (Function(
      'return import("@midnight-ntwrk/zkir-v2")',
    )() as Promise<typeof mod>);
    return mod.Zkir.fromJson(rawJson).getK();
  } catch {
    return null;
  }
}

export interface ProfileOptions {
  /** Which environments to evaluate. Keys into the environments map. */
  targets?: string[];
  kSource?: "estimate" | "wasm" | "auto";
  costOverrides?: Record<string, RowCost>;
  rawJson?: string;
  maxK?: number;
  /** Custom or overridden environment models from config. */
  environments?: Record<string, EnvironmentConfig>;
}

/**
 * Profile a circuit's proving performance.
 */
export async function profileCircuit(
  zkir: ZkirV2 | ZkirV3,
  options: ProfileOptions = {},
): Promise<CircuitProfile> {
  // If caller provides a resolved environments map, use it as-is.
  // The CLI merges config with defaults and removes nulls before passing.
  const envs = options.environments ?? DEFAULT_ENVIRONMENTS;

  const targetNames = options.targets ?? Object.keys(envs);
  const kSourcePref = options.kSource ?? "auto";

  const estimate = estimateK(zkir, options.costOverrides);
  let k = estimate.k;
  let kSource: KSource = "estimated";

  if (
    (kSourcePref === "wasm" || kSourcePref === "auto") &&
    options.rawJson
  ) {
    const wasmK = await tryWasmK(options.rawJson);
    if (wasmK != null) {
      k = wasmK;
      kSource = "exact-wasm";
    } else if (kSourcePref === "wasm") {
      throw new Error(
        "WASM k-source requested but @midnight-ntwrk/zkir-v2 " +
          "is not installed. Install it or use --k-source estimate.",
      );
    }
  }

  const estimates: ProvingEstimate[] = [];
  for (const name of targetNames) {
    const env = envs[name];
    if (env == null) continue;
    estimates.push(estimateForEnvironment(k, name, env));
  }

  return {
    k,
    kSource,
    rows: estimate.rows,
    tableRows: estimate.tableRows,
    hashCount: estimate.hashCount,
    hashRows: estimate.hashRows,
    ecOpCount: estimate.ecOpCount,
    ecOpRows: estimate.ecOpRows,
    estimates,
    maxK: options.maxK,
  };
}

/** Format seconds as human-readable duration. */
export function formatDuration(seconds: number): string {
  if (!isFinite(seconds)) return "infeasible";
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (secs === 0) return `~${mins}min`;
  return `~${mins}min ${secs}s`;
}

/** Format a proving estimate range as a human-readable string. */
export function formatEstimateRange(
  est: ProvingEstimate,
): string {
  if (!est.feasible) return "infeasible";
  const [lo, hi] = est.estimatedSeconds;
  return `${formatDuration(lo)}-${formatDuration(hi)}`;
}
