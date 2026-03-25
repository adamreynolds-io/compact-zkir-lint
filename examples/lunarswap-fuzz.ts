#!/usr/bin/env npx tsx
/**
 * Example: Differential fuzz testing for LunarSwap addLiquidity.
 *
 * Prerequisites:
 *   - Compiled LunarSwap contract (index.js + zkir/*.zkir)
 *   - @midnight-ntwrk/compact-runtime, onchain-runtime-v3, zkir-v2 installed
 *
 * This example shows how to wire up zkir-lint's fuzz harness with
 * a real Compact contract to find JS/ZK divergences.
 *
 * Usage:
 *   cd midnight-apps/contracts
 *   npx tsx ../../zkir-lint/examples/lunarswap-fuzz.ts
 */

// --- Types only (consumer provides actual imports) ---
// import { Contract, ledger } from '../src/artifacts/lunarswap/Lunarswap/contract/index.js';
// import { createConstructorContext, createCircuitContext } from '@midnight-ntwrk/compact-runtime';
// import * as ocrt from '@midnight-ntwrk/onchain-runtime-v3';
// import { checkProofData } from '@compact/test-center/key-provider.js';

import { readFileSync } from "node:fs";
import {
  generateFuzzInputs,
  extractBranchConditions,
  generateBranchTargetInputs,
  analyzeFile,
  formatDiffSummary,
  type FuzzInput,
  type ZkirV2,
} from "../src/index.js";

/**
 * Standalone fuzz input generation and static analysis.
 * This part works without any Midnight dependencies.
 */
function analyzeAndGenerateInputs(zkirPath: string) {
  // Step 1: Static analysis
  console.log("=== Static Analysis ===\n");
  const report = analyzeFile(zkirPath);

  const errors = report.findings.filter((f) => f.severity === "error");
  const warns = report.findings.filter((f) => f.severity === "warn");
  console.log(`${report.name}: ${errors.length} errors, ${warns.length} warnings`);
  console.log(`  ${report.stats.totalInstructions} instructions`);
  console.log(`  ${report.stats.guardedRegions} guarded regions (max depth ${report.stats.maxGuardDepth})`);
  console.log(`  ${report.stats.constrainBitsCount} constrain_bits, ${report.stats.condSelectCount} cond_select\n`);

  if (errors.length > 0) {
    console.log("Errors:");
    for (const e of errors.slice(0, 5)) {
      console.log(`  [${e.rule}] inst ${e.instructionIndex}: ${e.message}`);
    }
    if (errors.length > 5) console.log(`  ... and ${errors.length - 5} more`);
    console.log();
  }

  // Step 2: Generate fuzz inputs
  console.log("=== Fuzz Input Generation ===\n");
  const zkir: ZkirV2 = JSON.parse(readFileSync(zkirPath, "utf-8"));
  const fuzzInputs = generateFuzzInputs(zkir, 30);

  console.log(`Generated ${fuzzInputs.length} fuzz inputs for ${zkir.num_inputs} circuit inputs:`);
  for (const strategy of ["zero", "max", "boundary", "random"] as const) {
    const count = fuzzInputs.filter((f) => f.strategy === strategy).length;
    if (count > 0) console.log(`  ${strategy}: ${count}`);
  }

  // Step 3: Branch-targeted inputs
  const conditions = extractBranchConditions(zkir);
  console.log(`\n${conditions.length} branch conditions found`);

  let branchInputs: FuzzInput[] = [];
  for (const cond of conditions.slice(0, 5)) {
    branchInputs.push(...generateBranchTargetInputs(zkir, cond));
  }
  console.log(`Generated ${branchInputs.length} branch-targeted inputs\n`);

  // Step 4: Show integration example
  console.log("=== Integration Example ===\n");
  console.log(`To run differential testing, wire up the harness:

  import { createHarness, fuzzCircuit } from 'zkir-lint';
  import { Contract } from './artifacts/lunarswap/Lunarswap/contract/index.js';
  import { checkProofData } from '@compact/test-center/key-provider.js';

  const harness = createHarness({
    contractDir: './artifacts/lunarswap/Lunarswap',
    contract: new Contract(witnesses),
    initialState: (c) => c.initialState(constructorCtx, ...args),
    createContext: (cs, ps, cpk) => createCircuitContext(...),
    checkProofData: (name, pd) => checkProofData(contractDir, name, pd),
  });

  const results = await fuzzCircuit(harness, 'addLiquidity', {
    inputs: fuzzInputs,
    verbose: true,
    resetBetweenRuns: true,
  });

  if (results.divergences > 0) {
    console.error(formatDiffSummary(results));
    process.exit(1);
  }
`);

  return { report, fuzzInputs, branchInputs, conditions };
}

// Run if invoked directly
const zkirPath = process.argv[2];
if (!zkirPath) {
  console.log("Usage: npx tsx examples/lunarswap-fuzz.ts <path/to/circuit.zkir>");
  console.log("\nExample:");
  console.log("  npx tsx examples/lunarswap-fuzz.ts contracts/src/artifacts/lunarswap/Lunarswap/zkir/addLiquidity.zkir");
  process.exit(1);
}

analyzeAndGenerateInputs(zkirPath);
