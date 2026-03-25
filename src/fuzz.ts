/**
 * ZKIR-guided fuzz input generator.
 *
 * Parses compiled ZKIR to extract:
 * - Input count and bit-width constraints
 * - Branch conditions (test_eq, less_than) for targeted input generation
 * - Boundary values for constrain_bits targets
 *
 * Generates input vectors that maximize branch coverage,
 * specifically targeting both sides of each conditional.
 */

import type { ZkirV2 } from "./types.js";
import { buildIrGraph, type IrGraph } from "./ir.js";

/** A generated test input vector with metadata about what it targets. */
export interface FuzzInput {
  /** Input values as bigint (one per circuit input). */
  values: bigint[];
  /** What this input targets. */
  target: string;
  /** The branch condition this input is designed to exercise. */
  strategy: "boundary" | "branch-true" | "branch-false" | "random" | "zero" | "max";
}

/** Constraints extracted from ZKIR for each input variable. */
export interface InputConstraint {
  /** Input variable index. */
  inputIndex: number;
  /** Maximum bit width from constrain_bits. */
  maxBits: number;
}

/**
 * Extract input constraints from ZKIR.
 * Finds constrain_bits instructions that directly constrain input variables.
 */
export function extractInputConstraints(zkir: ZkirV2): InputConstraint[] {
  const constraints: InputConstraint[] = [];
  const seen = new Set<number>();

  for (const inst of zkir.instructions) {
    if (inst.op === "constrain_bits") {
      const v = inst.var as number;
      const bits = inst.bits as number;
      if (v < zkir.num_inputs && !seen.has(v)) {
        seen.add(v);
        constraints.push({ inputIndex: v, maxBits: bits });
      }
    }
  }

  // Fill in unconstrained inputs with field-width default
  for (let i = 0; i < zkir.num_inputs; i++) {
    if (!seen.has(i)) {
      constraints.push({ inputIndex: i, maxBits: 253 });
    }
  }

  return constraints.sort((a, b) => a.inputIndex - b.inputIndex);
}

/**
 * Extract branch conditions from ZKIR.
 * Finds test_eq and less_than instructions that are used as cond_select bits.
 */
export function extractBranchConditions(
  zkir: ZkirV2,
): Array<{ instIndex: number; op: string; operands: number[]; bits?: number }> {
  const graph = buildIrGraph(zkir);
  const conditions: Array<{
    instIndex: number;
    op: string;
    operands: number[];
    bits?: number;
  }> = [];

  // Find all cond_select bit variables
  const condBits = new Set<number>();
  for (const inst of zkir.instructions) {
    if (inst.op === "cond_select") {
      condBits.add(inst.bit as number);
    }
  }

  // Find the instructions that produce those condition variables
  for (const [varNum, instIdx] of graph.varToInst) {
    if (!condBits.has(varNum)) continue;
    const inst = zkir.instructions[instIdx]!;
    if (inst.op === "test_eq" || inst.op === "less_than") {
      conditions.push({
        instIndex: instIdx,
        op: inst.op,
        operands: [inst.a as number, inst.b as number],
        bits: inst.bits as number | undefined,
      });
    }
  }

  return conditions;
}

/** Generate a random bigint within [0, 2^bits). */
function randomBigint(bits: number): bigint {
  if (bits <= 0) return 0n;
  if (bits <= 53) {
    return BigInt(Math.floor(Math.random() * Number(2n ** BigInt(bits))));
  }
  // For larger bit widths, build from 32-bit chunks
  let result = 0n;
  let remaining = bits;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 32);
    const val = BigInt(Math.floor(Math.random() * Number(2n ** BigInt(chunk))));
    result = (result << BigInt(chunk)) | val;
    remaining -= chunk;
  }
  return result;
}

/**
 * Generate fuzz inputs for a ZKIR circuit.
 *
 * Strategies:
 * 1. Zero vector — all inputs are 0
 * 2. Max vector — each input at its maximum valid value
 * 3. Boundary values — 0, 1, max-1, max for each constrained input
 * 4. Random vectors — random values within valid ranges
 * 5. Branch targeting — values designed to flip specific conditions
 */
export function generateFuzzInputs(
  zkir: ZkirV2,
  count: number = 50,
): FuzzInput[] {
  const constraints = extractInputConstraints(zkir);
  const numInputs = zkir.num_inputs;
  const inputs: FuzzInput[] = [];

  // Helper: create a default valid vector
  const defaultVector = (): bigint[] =>
    constraints.map((c) => {
      if (c.maxBits <= 1) return 1n;
      return 1n; // safe default
    });

  // Strategy 1: Zero vector
  inputs.push({
    values: new Array<bigint>(numInputs).fill(0n),
    target: "all-zero",
    strategy: "zero",
  });

  // Strategy 2: Max vector
  inputs.push({
    values: constraints.map((c) => (1n << BigInt(c.maxBits)) - 1n),
    target: "all-max",
    strategy: "max",
  });

  // Strategy 3: Boundary values for each input
  for (let i = 0; i < numInputs && i < constraints.length; i++) {
    const c = constraints[i]!;
    const maxVal = (1n << BigInt(c.maxBits)) - 1n;
    const boundaries = [0n, 1n, maxVal - 1n, maxVal];

    for (const boundary of boundaries) {
      const vec = defaultVector();
      vec[i] = boundary;
      inputs.push({
        values: vec,
        target: `input[${i}]=${boundary}`,
        strategy: "boundary",
      });
    }
  }

  // Strategy 4: Random vectors
  const randomCount = Math.max(
    10,
    count - inputs.length,
  );
  for (let r = 0; r < randomCount; r++) {
    inputs.push({
      values: constraints.map((c) => randomBigint(c.maxBits)),
      target: `random-${r}`,
      strategy: "random",
    });
  }

  return inputs.slice(0, count);
}

/**
 * Generate targeted inputs for a specific branch condition.
 * Traces the condition operands back to circuit inputs and generates
 * values that make the condition true and false.
 */
export function generateBranchTargetInputs(
  zkir: ZkirV2,
  condition: { op: string; operands: number[]; bits?: number },
): FuzzInput[] {
  const constraints = extractInputConstraints(zkir);
  const numInputs = zkir.num_inputs;
  const inputs: FuzzInput[] = [];
  const defaultVec = (): bigint[] =>
    new Array<bigint>(numInputs).fill(1n);

  // If either operand is a direct input, we can target it
  for (const op of condition.operands) {
    if (op < numInputs) {
      if (condition.op === "test_eq") {
        // Make equal: set input to match the other operand's likely value
        const vec1 = defaultVec();
        vec1[op] = 0n; // try zero (common comparison target)
        inputs.push({
          values: vec1,
          target: `branch-eq input[${op}]=0`,
          strategy: "branch-true",
        });

        const vec2 = defaultVec();
        vec2[op] = 42n; // try non-zero
        inputs.push({
          values: vec2,
          target: `branch-neq input[${op}]=42`,
          strategy: "branch-false",
        });
      }

      if (condition.op === "less_than" && condition.bits != null) {
        const boundary = 1n << BigInt(condition.bits - 1);
        // Below boundary
        const vec1 = defaultVec();
        vec1[op] = boundary - 1n;
        inputs.push({
          values: vec1,
          target: `branch-lt input[${op}]=${boundary - 1n}`,
          strategy: "branch-true",
        });

        // At boundary
        const vec2 = defaultVec();
        vec2[op] = boundary;
        inputs.push({
          values: vec2,
          target: `branch-gte input[${op}]=${boundary}`,
          strategy: "branch-false",
        });
      }
    }
  }

  return inputs;
}
