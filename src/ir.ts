/**
 * ZKIR instruction-level analysis utilities.
 *
 * Builds a data-flow graph from ZKIR instructions, tracking:
 * - Which instruction produces which memory variable
 * - Which variables are under a branch guard
 * - Which variables are safe (zero when guard is false)
 * - Guard nesting depth
 */

import type {
  Instruction,
  KEstimate,
  RowCost,
  ZkirV2,
  ZkirV3,
} from "./types.js";

/** Instructions that do NOT push a value to the memory vector. */
const NON_PRODUCING_OPS = new Set([
  "constrain_bits",
  "constrain_eq",
  "constrain_to_boolean",
  "assert",
  "declare_pub_input",
  "pi_skip",
  "output",
]);

export interface IrGraph {
  /** Number of circuit inputs (first N memory slots). */
  numInputs: number;
  /** Map instruction index → memory variable index (null if non-producing). */
  instToVar: (number | null)[];
  /** Map memory variable index → instruction index that produced it. */
  varToInst: Map<number, number>;
  /** Map memory variable → guard variable (if produced inside a guarded region). */
  varGuard: Map<number, number>;
  /** Set of variables produced by cond_select (branch merge points). */
  condSelectOutputs: Set<number>;
  /** Set of distinct guard variables used. */
  guards: Set<number>;
  /** Guard nesting: guard var → set of parent guards. */
  guardParents: Map<number, Set<number>>;
  /** Instructions array reference. */
  instructions: Instruction[];
}

export function buildIrGraph(zkir: ZkirV2 | ZkirV3): IrGraph {
  const isV2 = zkir.version.major === 2;
  const numInputs = isV2
    ? (zkir as ZkirV2).num_inputs
    : (zkir as ZkirV3).inputs.length;
  const insts = zkir.instructions;

  // Build instruction → memory variable mapping
  const instToVar: (number | null)[] = [];
  const varToInst = new Map<number, number>();
  let memIdx = numInputs;

  for (let i = 0; i < insts.length; i++) {
    const op = insts[i]!.op;
    if (NON_PRODUCING_OPS.has(op)) {
      instToVar.push(null);
    } else if (op === "div_mod_power_of_two") {
      instToVar.push(memIdx);
      varToInst.set(memIdx, i);
      varToInst.set(memIdx + 1, i);
      memIdx += 2;
    } else {
      instToVar.push(memIdx);
      varToInst.set(memIdx, i);
      memIdx += 1;
    }
  }

  // Track which guard each variable was produced under
  const varGuard = new Map<number, number>();
  const guards = new Set<number>();
  const guardParents = new Map<number, Set<number>>();

  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i]!;
    const varNum = instToVar[i];

    // Guarded inputs: track guard
    if (
      (inst.op === "private_input" || inst.op === "public_input") &&
      inst.guard != null
    ) {
      const guard = inst.guard as number;
      guards.add(guard);
      if (varNum != null) {
        varGuard.set(varNum, guard);
      }
    }

    // Arithmetic propagates guard from operands
    if (
      (inst.op === "add" ||
        inst.op === "mul" ||
        inst.op === "neg" ||
        inst.op === "copy" ||
        inst.op === "less_than" ||
        inst.op === "test_eq") &&
      varNum != null
    ) {
      const operands = getOperands(inst);
      for (const op of operands) {
        const g = varGuard.get(op);
        if (g != null) {
          varGuard.set(varNum, g);
          break;
        }
      }
    }
  }

  // Track guard nesting
  for (const guard of guards) {
    const parentGuard = varGuard.get(guard);
    if (parentGuard != null) {
      if (!guardParents.has(guard)) guardParents.set(guard, new Set());
      guardParents.get(guard)!.add(parentGuard);
    }
  }

  // cond_select outputs
  const condSelectOutputs = new Set<number>();
  for (let i = 0; i < insts.length; i++) {
    if (insts[i]!.op === "cond_select" && instToVar[i] != null) {
      condSelectOutputs.add(instToVar[i]!);
    }
  }

  return {
    numInputs,
    instToVar,
    varToInst,
    varGuard,
    condSelectOutputs,
    guards,
    guardParents,
    instructions: insts,
  };
}

export function getOperands(inst: Instruction): number[] {
  const ops: number[] = [];
  if (inst.a != null) ops.push(inst.a as number);
  if (inst.b != null) ops.push(inst.b as number);
  if (inst.var != null && inst.op !== "constrain_bits") {
    ops.push(inst.var as number);
  }
  return ops;
}

/**
 * Determines if a variable is guaranteed to be zero when its guard is false.
 * Uses memoized recursive analysis.
 */
export function buildZeroAnalysis(graph: IrGraph): (v: number) => boolean {
  const cache = new Map<number, boolean>();
  const inProgress = new Set<number>();

  const isZeroWhenGuardFalse = (v: number): boolean => {
    const cached = cache.get(v);
    if (cached != null) return cached;
    if (inProgress.has(v)) return false;
    inProgress.add(v);

    let result = false;

    if (!graph.varGuard.has(v)) {
      result = false;
    } else {
      const prodIdx = graph.varToInst.get(v);
      if (prodIdx == null) {
        result = false;
      } else {
        const inst = graph.instructions[prodIdx]!;
        if (inst.op === "private_input" || inst.op === "public_input") {
          result = true;
        } else if (inst.op === "mul") {
          // 0 * anything = 0
          result = getOperands(inst).some((op) => isZeroWhenGuardFalse(op));
        } else if (inst.op === "add") {
          // 0 + 0 = 0
          result = getOperands(inst).every(
            (op) => isZeroWhenGuardFalse(op) || op < graph.numInputs,
          );
        } else if (inst.op === "neg" || inst.op === "copy") {
          result = getOperands(inst).every((op) => isZeroWhenGuardFalse(op));
        }
      }
    }

    cache.set(v, result);
    inProgress.delete(v);
    return result;
  };

  return isZeroWhenGuardFalse;
}

/**
 * Row costs per ZKIR instruction, from Midnight proving system golden files.
 * Source: midnight-zk/zk_stdlib/goldenfiles/cost-model.json
 *         midnight-zk/circuits/goldenfiles/cost-model.json
 */
const DEFAULT_ROW_COSTS: Record<string, RowCost> = {
  persistent_hash: { rows: 704, tableRows: 2 },
  transient_hash: { rows: 704, tableRows: 2 },
  hash_to_curve: { rows: 640, tableRows: 99 },
  ec_mul: { rows: 500, tableRows: 0 },
  ec_mul_generator: { rows: 500, tableRows: 0 },
  less_than: { rows: 15, tableRows: 0 },
  reconstitute_field: { rows: 8, tableRows: 0 },
  div_mod_power_of_two: { rows: 10, tableRows: 0 },
  constrain_bits: { rows: 3, tableRows: 0 },
  constrain_eq: { rows: 2, tableRows: 0 },
  constrain_to_boolean: { rows: 2, tableRows: 0 },
  assert: { rows: 2, tableRows: 0 },
};

const DEFAULT_ROW_COST: RowCost = { rows: 1, tableRows: 0 };

/** Blinding factors + 1 (unusable rows), standard for Halo2 degree-5. */
const UNUSABLE_ROWS = 6;

/** Poseidon commitment rows when do_communications_commitment is true. */
const COMMS_COMMITMENT_ROWS = 704;

/**
 * Estimate the k value (log2 of circuit rows) from ZKIR instructions.
 *
 * Uses hardcoded row costs from Midnight's proving system golden files.
 * Returns an estimate — for exact k, use the WASM module's Zkir.getK().
 */
export function estimateK(
  zkir: ZkirV2 | ZkirV3,
  costOverrides?: Record<string, RowCost>,
): KEstimate {
  const costs = costOverrides
    ? { ...DEFAULT_ROW_COSTS, ...costOverrides }
    : DEFAULT_ROW_COSTS;

  let rows = 0;
  let tableRows = 0;
  let hashCount = 0;
  let hashRows = 0;
  let ecOpCount = 0;
  let ecOpRows = 0;
  let instanceCount = 0;

  for (const inst of zkir.instructions) {
    const cost = costs[inst.op] ?? DEFAULT_ROW_COST;
    rows += cost.rows;
    tableRows = Math.max(tableRows, cost.tableRows);

    if (
      inst.op === "persistent_hash" ||
      inst.op === "transient_hash" ||
      inst.op === "hash_to_curve"
    ) {
      hashCount++;
      hashRows += cost.rows;
    }

    if (inst.op === "ec_mul" || inst.op === "ec_mul_generator") {
      ecOpCount++;
      ecOpRows += cost.rows;
    }

    if (inst.op === "declare_pub_input") {
      instanceCount++;
    }
  }

  if (zkir.do_communications_commitment) {
    rows += COMMS_COMMITMENT_ROWS;
  }

  const minCircuitSize = Math.max(
    rows + UNUSABLE_ROWS,
    tableRows + UNUSABLE_ROWS,
    instanceCount + UNUSABLE_ROWS,
  );

  const k = Math.ceil(Math.log2(Math.max(minCircuitSize, 1)));

  return { k, rows, tableRows, hashCount, hashRows, ecOpCount, ecOpRows };
}

/** Get the guard nesting depth for a given guard variable. */
export function guardDepth(
  graph: IrGraph,
  guard: number,
  visited?: Set<number>,
): number {
  const seen = visited ?? new Set<number>();
  if (seen.has(guard)) return 0;
  seen.add(guard);

  const parents = graph.guardParents.get(guard);
  if (!parents || parents.size === 0) return 1;

  let maxParentDepth = 0;
  for (const parent of parents) {
    maxParentDepth = Math.max(maxParentDepth, guardDepth(graph, parent, seen));
  }
  return 1 + maxParentDepth;
}
