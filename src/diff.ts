/**
 * Differential testing engine.
 *
 * Runs a compiled Compact circuit through both:
 * 1. compact-runtime (JS) — BigInt arithmetic, real branching
 * 2. ZKIR preprocessing (WASM) — field arithmetic, unconditional execution
 *
 * Reports any divergence where JS succeeds but ZKIR fails.
 *
 * This module provides the core `DiffRunner` class and types.
 * The actual WASM dependencies (compact-runtime, onchain-runtime-v3,
 * zkir-v2/v3) must be provided by the consumer since they're heavy
 * npm packages that we don't want as direct dependencies.
 */

import type { FuzzInput } from "./fuzz.js";

/** Result of a single differential test run. */
export interface DiffResult {
  /** The circuit that was tested. */
  circuitName: string;
  /** The input that was used. */
  input: FuzzInput;
  /** Whether the JS runtime succeeded. */
  jsSuccess: boolean;
  /** JS error message if it failed. */
  jsError?: string;
  /** Whether the ZKIR check succeeded. */
  zkirSuccess: boolean;
  /** ZKIR error message if it failed. */
  zkirError?: string;
  /** Time taken for JS execution (ms). */
  jsTimeMs: number;
  /** Time taken for ZKIR check (ms). */
  zkirTimeMs: number;
  /** Whether this is a divergence (JS pass + ZKIR fail). */
  isDivergence: boolean;
}

/** Summary of a differential test campaign. */
export interface DiffSummary {
  circuitName: string;
  totalRuns: number;
  jsSuccesses: number;
  jsFailures: number;
  zkirSuccesses: number;
  zkirFailures: number;
  divergences: number;
  results: DiffResult[];
}

/**
 * Dependencies that must be injected by the consumer.
 * These are the heavy WASM packages from the Midnight ecosystem.
 */
export interface DiffDeps {
  /**
   * Execute a circuit and return its ProofData.
   * This wraps the compiled contract's circuit call.
   *
   * @param circuitName - Name of the circuit to execute
   * @param inputs - Input values as bigint array
   * @returns ProofData from the circuit execution, or throws if JS fails
   */
  executeCircuit: (
    circuitName: string,
    inputs: bigint[],
  ) => { proofData: unknown; result: unknown };

  /**
   * Check ProofData against the ZKIR.
   * This wraps checkProofData from compact/test-center.
   *
   * @param circuitName - Circuit name (used to find .zkir file)
   * @param proofData - ProofData from executeCircuit
   * @returns resolves if check passes, rejects with error if it fails
   */
  checkProof: (
    circuitName: string,
    proofData: unknown,
  ) => Promise<unknown>;
}

/**
 * Runs differential tests on a circuit with provided inputs.
 */
export async function runDiffTests(
  deps: DiffDeps,
  circuitName: string,
  inputs: FuzzInput[],
  options: { stopOnDivergence?: boolean; verbose?: boolean } = {},
): Promise<DiffSummary> {
  const results: DiffResult[] = [];
  let divergenceCount = 0;

  for (const input of inputs) {
    let jsSuccess = false;
    let jsError: string | undefined;
    let jsTimeMs = 0;
    let proofData: unknown = null;

    // Step 1: Run through JS runtime
    const jsStart = performance.now();
    try {
      const circuitResult = deps.executeCircuit(circuitName, input.values);
      proofData = circuitResult.proofData;
      jsSuccess = true;
    } catch (e) {
      jsError = e instanceof Error ? e.message : String(e);
    }
    jsTimeMs = performance.now() - jsStart;

    // Step 2: If JS succeeded, check against ZKIR
    let zkirSuccess = false;
    let zkirError: string | undefined;
    let zkirTimeMs = 0;

    if (jsSuccess && proofData != null) {
      const zkirStart = performance.now();
      try {
        await deps.checkProof(circuitName, proofData);
        zkirSuccess = true;
      } catch (e) {
        zkirError = e instanceof Error ? e.message : String(e);
      }
      zkirTimeMs = performance.now() - zkirStart;
    } else {
      // JS failed — ZKIR check is N/A (not a divergence)
      zkirSuccess = false;
      zkirError = "skipped (JS failed)";
    }

    const isDivergence = jsSuccess && !zkirSuccess;
    if (isDivergence) divergenceCount++;

    const result: DiffResult = {
      circuitName,
      input,
      jsSuccess,
      jsError,
      zkirSuccess,
      zkirError,
      jsTimeMs,
      zkirTimeMs,
      isDivergence,
    };

    results.push(result);

    if (options.verbose) {
      const status = isDivergence
        ? "DIVERGENCE"
        : jsSuccess && zkirSuccess
          ? "pass"
          : "fail (both)";
      const inputStr = input.values.map((v) =>
        v > 1000n ? `${v.toString().slice(0, 6)}...` : v.toString()
      ).join(", ");
      console.log(
        `  [${status}] ${input.strategy}:${input.target} (${inputStr}) ` +
        `js=${jsTimeMs.toFixed(0)}ms zkir=${zkirTimeMs.toFixed(0)}ms`,
      );
    }

    if (isDivergence && options.stopOnDivergence) break;
  }

  return {
    circuitName,
    totalRuns: results.length,
    jsSuccesses: results.filter((r) => r.jsSuccess).length,
    jsFailures: results.filter((r) => !r.jsSuccess).length,
    zkirSuccesses: results.filter((r) => r.zkirSuccess).length,
    zkirFailures: results.filter((r) => !r.zkirSuccess && r.jsSuccess).length,
    divergences: divergenceCount,
    results,
  };
}

/** Format a DiffSummary as human-readable text. */
export function formatDiffSummary(summary: DiffSummary): string {
  const lines: string[] = [];
  lines.push(`Circuit: ${summary.circuitName}`);
  lines.push(`  Total: ${summary.totalRuns} runs`);
  lines.push(
    `  JS:   ${summary.jsSuccesses} pass, ${summary.jsFailures} fail`,
  );
  lines.push(
    `  ZKIR: ${summary.zkirSuccesses} pass, ${summary.zkirFailures} fail`,
  );

  if (summary.divergences > 0) {
    lines.push(`  DIVERGENCES: ${summary.divergences}`);
    lines.push("");

    for (const r of summary.results.filter((r) => r.isDivergence)) {
      lines.push(`  [DIVERGENCE] ${r.input.strategy}:${r.input.target}`);
      lines.push(`    Inputs: [${r.input.values.join(", ")}]`);
      lines.push(`    JS: success`);
      lines.push(`    ZKIR: ${r.zkirError}`);
      lines.push("");
    }
  } else {
    lines.push("  No divergences found.");
  }

  return lines.join("\n");
}
