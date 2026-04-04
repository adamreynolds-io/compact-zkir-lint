/**
 * Lint rules for ZKIR static analysis.
 *
 * Each rule is a function that takes an IrGraph and returns findings.
 */

import {
  buildZeroAnalysis,
  getOperands,
  guardDepth,
  type IrGraph,
} from "./ir.js";
import type { Finding } from "./types.js";

export type Rule = (graph: IrGraph) => Finding[];

/**
 * DIV-001: Unconditional constrain_bits on arithmetic results in guarded regions.
 *
 * The #226 pattern: `as Uint<N>` inside a conditional branch generates a
 * constrain_bits that fires unconditionally in ZK. When the branch is not taken,
 * the dead computation may produce out-of-range values that fail the constraint.
 *
 * Example: tests/fixtures/compact/div-001-downcast-in-branch.compact
 * Compiler FIXME: passes.ss:9676
 */
export const unconditionalConstrainBits: Rule = (graph) => {
  const findings: Finding[] = [];
  const isZero = buildZeroAnalysis(graph);
  const { instructions: insts, varGuard, condSelectOutputs, varToInst } = graph;

  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i]!;
    if (inst.op !== "constrain_bits") continue;

    const targetVar = inst.var as number;
    const bits = inst.bits as number;
    const guard = varGuard.get(targetVar);

    if (guard == null || condSelectOutputs.has(targetVar)) continue;

    // Check if value is safely zero when guard is false
    if (isZero(targetVar)) continue;

    const producerIdx = varToInst.get(targetVar);
    const producer = producerIdx != null ? insts[producerIdx] : null;

    findings.push({
      severity: "error",
      rule: "DIV-001",
      instructionIndex: i,
      memoryVar: targetVar,
      message: `constrain_bits(var=${targetVar}, bits=${bits}) on arithmetic result in guarded region (guard=${guard})`,
      details:
        `Producer: ${producer ? JSON.stringify(producer) : `input[${targetVar}]`}. ` +
        `This constraint fires unconditionally in ZK. When guard var ${guard} is false, ` +
        `the dead branch computation may produce out-of-range values.`,
    });
  }

  return findings;
};

/**
 * DIV-002: reconstitute_field in guarded regions.
 *
 * reconstitute_field emits internal constraints. If its operands are from a
 * guarded region, those constraints fire unconditionally.
 *
 * Example: tests/fixtures/compact/div-002-bytes-to-field-in-branch.compact
 * Compiler FIXME: passes.ss:9671 "zkir bytes->field needs to respect test"
 */
export const unconditionalReconstituteField: Rule = (graph) => {
  const findings: Finding[] = [];
  const { instructions: insts, varGuard } = graph;

  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i]!;
    if (inst.op !== "reconstitute_field") continue;

    const divisor = inst.divisor as number;
    const modulus = inst.modulus as number;
    const divisorGuard = varGuard.get(divisor);
    const modulusGuard = varGuard.get(modulus);

    if (divisorGuard == null && modulusGuard == null) continue;

    const guard = divisorGuard ?? modulusGuard;
    findings.push({
      severity: "error",
      rule: "DIV-002",
      instructionIndex: i,
      memoryVar: null,
      message: `reconstitute_field with guarded operands (guard=${guard})`,
      details:
        `Operands: divisor=var${divisor}, modulus=var${modulus}. ` +
        `reconstitute_field emits internal constraints that fire unconditionally. ` +
        `Compiler FIXME: passes.ss:9671 "zkir bytes->field needs to respect test".`,
    });
  }

  return findings;
};

/**
 * DIV-003: div_mod_power_of_two in guarded regions.
 *
 * div_mod_power_of_two internally decomposes a value into quotient and remainder
 * using bit extraction. If the input is from a guarded region, the bit extraction
 * may produce unexpected results on dead-branch values.
 *
 * Example: tests/fixtures/compact/div-003-field-to-bytes-in-branch.compact
 * Compiler FIXME: passes.ss:9350 "zkir field->bytes needs to respect test"
 */
export const unconditionalDivMod: Rule = (graph) => {
  const findings: Finding[] = [];
  const { instructions: insts, varGuard } = graph;

  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i]!;
    if (inst.op !== "div_mod_power_of_two") continue;

    const inputVar = inst.var as number;
    const guard = varGuard.get(inputVar);
    if (guard == null) continue;

    findings.push({
      severity: "warn",
      rule: "DIV-003",
      instructionIndex: i,
      memoryVar: null,
      message: `div_mod_power_of_two on guarded value var=${inputVar} (guard=${guard})`,
      details:
        `div_mod_power_of_two extracts bits from field elements. When the guard is false, ` +
        `the input defaults to 0, which decomposes safely. However, this pattern ` +
        `corresponds to field->bytes in a conditional branch. ` +
        `Compiler FIXME: passes.ss:9350 "zkir field->bytes needs to respect test".`,
    });
  }

  return findings;
};

/**
 * DIV-004: assert on branch-local values.
 *
 * An assert on a value derived from guarded computation fires unconditionally.
 * If the dead branch produces a false condition, the assert fails even though
 * the branch is logically unreachable.
 *
 * Example: tests/fixtures/compact/div-004-assert-in-branch.compact
 * Note: compiler 0.30.0 wraps assert with cond_select, so this is clean.
 * The rule detects regressions if a future compiler drops the wrapper.
 */
export const unconditionalAssert: Rule = (graph) => {
  const findings: Finding[] = [];
  const { instructions: insts, varGuard, condSelectOutputs } = graph;

  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i]!;
    if (inst.op !== "assert") continue;

    const condVar = inst.cond as number;
    const guard = varGuard.get(condVar);

    if (guard == null || condSelectOutputs.has(condVar)) continue;

    findings.push({
      severity: "warn",
      rule: "DIV-004",
      instructionIndex: i,
      memoryVar: null,
      message: `assert(cond=var${condVar}) on branch-local value (guard=${guard})`,
      details:
        `This assert fires unconditionally in ZK. If the dead branch produces ` +
        `a false condition, the assert fails even though the branch is unreachable.`,
    });
  }

  return findings;
};

/**
 * STATS-001: Deep guard nesting.
 *
 * Deeply nested conditionals multiply the risk of unconditional constraint
 * failures and increase circuit complexity.
 */
export const deepGuardNesting: Rule = (graph) => {
  const findings: Finding[] = [];

  for (const guard of graph.guards) {
    const depth = guardDepth(graph, guard);
    if (depth >= 4) {
      findings.push({
        severity: "info",
        rule: "STATS-001",
        instructionIndex: -1,
        memoryVar: guard,
        message: `Guard var=${guard} has nesting depth ${depth}`,
        details:
          `Deeply nested conditionals (depth >= 4) multiply the risk of ` +
          `unconditional constraint failures and increase circuit complexity.`,
      });
    }
  }

  return findings;
};

/**
 * STATS-002: Constraint density.
 *
 * Reports circuits where > 20% of instructions are constraint checks,
 * which may indicate over-constraining or redundant bit checks.
 */
export const constraintDensity: Rule = (graph) => {
  const findings: Finding[] = [];
  const total = graph.instructions.length;
  if (total === 0) return findings;

  let constraintCount = 0;
  for (const inst of graph.instructions) {
    if (
      inst.op === "constrain_bits" ||
      inst.op === "constrain_eq" ||
      inst.op === "constrain_to_boolean" ||
      inst.op === "assert"
    ) {
      constraintCount++;
    }
  }

  const ratio = constraintCount / total;
  if (ratio > 0.25) {
    findings.push({
      severity: "info",
      rule: "STATS-002",
      instructionIndex: -1,
      memoryVar: null,
      message: `High constraint density: ${constraintCount}/${total} (${(ratio * 100).toFixed(1)}%)`,
      details:
        `Over 25% of instructions are constraint checks. This may indicate ` +
        `redundant bit constraints from the compiler or overly defensive code.`,
    });
  }

  return findings;
};

/**
 * DIV-005: constrain_eq in guarded regions.
 *
 * Similar to constrain_bits, constrain_eq fires unconditionally. If operands
 * are from a guarded region, the equality check may fail on dead-branch values.
 *
 * Example: tests/fixtures/compact/div-005-constrain-eq-in-branch.compact
 */
export const unconditionalConstrainEq: Rule = (graph) => {
  const findings: Finding[] = [];
  const { instructions: insts, varGuard, condSelectOutputs } = graph;

  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i]!;
    if (inst.op !== "constrain_eq") continue;

    const a = inst.a as number;
    const b = inst.b as number;
    const guardA = varGuard.get(a);
    const guardB = varGuard.get(b);

    if (guardA == null && guardB == null) continue;
    if (condSelectOutputs.has(a) && condSelectOutputs.has(b)) continue;

    const guard = guardA ?? guardB;
    findings.push({
      severity: "warn",
      rule: "DIV-005",
      instructionIndex: i,
      memoryVar: null,
      message: `constrain_eq(a=var${a}, b=var${b}) with guarded operand (guard=${guard})`,
      details:
        `constrain_eq fires unconditionally. If one operand is from a dead branch ` +
        `(defaulting to 0) and the other is a live value, the equality fails.`,
    });
  }

  return findings;
};

/**
 * RT-001: Persistent hash with guarded inputs.
 *
 * persistent_hash in ZKIR parses field elements back through alignment,
 * then converts to binary for hashing. If inputs are from guarded regions
 * (defaulting to 0), the alignment parsing may produce different binary
 * than what the JS runtime hashed (which used AlignedValue directly).
 *
 * Example: tests/fixtures/compact/rt-001-persistent-hash-guarded.compact
 */
export const persistentHashGuardedInputs: Rule = (graph) => {
  const findings: Finding[] = [];
  const { instructions: insts, varGuard } = graph;

  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i]!;
    if (inst.op !== "persistent_hash") continue;

    const inputVars = inst.inputs as number[] | undefined;
    if (!inputVars) continue;

    const guardedInputs = inputVars.filter((v) => varGuard.has(v));
    if (guardedInputs.length === 0) continue;

    findings.push({
      severity: "warn",
      rule: "RT-001",
      instructionIndex: i,
      memoryVar: null,
      message: `persistent_hash with ${guardedInputs.length} guarded input(s)`,
      details:
        `ZKIR re-parses field elements via alignment before hashing. ` +
        `If guarded inputs default to 0, the alignment parsing may produce ` +
        `different binary than the JS runtime's direct AlignedValue hashing. ` +
        `Guarded vars: ${guardedInputs.join(", ")}.`,
    });
  }

  return findings;
};

/**
 * RT-002: LessThan with guarded operands.
 *
 * ZKIR less_than extracts N bits from each operand, then compares the
 * truncated values. If operands are from guarded regions (default 0),
 * the bit extraction is safe (0 truncated is 0). But if operands mix
 * guarded and unguarded values in arithmetic before the comparison,
 * the truncation may produce unexpected results in dead branches.
 *
 * Example: tests/fixtures/compact/rt-002-less-than-guarded.compact
 */
export const lessThanGuardedOperands: Rule = (graph) => {
  const findings: Finding[] = [];
  const isZero = buildZeroAnalysis(graph);
  const { instructions: insts, varGuard, condSelectOutputs } = graph;

  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i]!;
    if (inst.op !== "less_than") continue;

    const a = inst.a as number;
    const b = inst.b as number;
    const bits = inst.bits as number | undefined;

    const aGuard = varGuard.get(a);
    const bGuard = varGuard.get(b);
    if (aGuard == null && bGuard == null) continue;

    // If both operands are zero-when-guarded, comparison is 0 < 0 = false — safe
    if (isZero(a) && isZero(b)) continue;
    // If only one is zero-when-guarded, comparison is 0 < X or X < 0 — may be wrong
    // but the result is used in cond_select so it just picks the wrong branch value
    // which is then discarded. Still flag for awareness.

    if (!condSelectOutputs.has(a) || !condSelectOutputs.has(b)) {
      findings.push({
        severity: "info",
        rule: "RT-002",
        instructionIndex: i,
        memoryVar: null,
        message: `less_than(a=var${a}, b=var${b}, bits=${bits}) with guarded operand`,
        details:
          `ZKIR less_than extracts ${bits} bits from each operand before comparing. ` +
          `Guarded operands default to 0 in dead branches. The comparison result ` +
          `feeds into cond_select, so incorrect results are discarded, but the ` +
          `bit extraction itself may trigger constraints.`,
      });
    }
  }

  return findings;
};

/**
 * RT-003: Transient hash with guarded inputs.
 *
 * Similar to RT-001 but for transient_hash. The JS runtime calls
 * type.toValue() which may truncate trailing zeros (CompactTypeBytes),
 * while ZKIR receives raw field elements. If guarded inputs produce
 * different field values than what JS serialized, the hash diverges.
 *
 * Example: tests/fixtures/compact/rt-003-transient-hash-guarded.compact
 */
export const transientHashGuardedInputs: Rule = (graph) => {
  const findings: Finding[] = [];
  const { instructions: insts, varGuard } = graph;

  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i]!;
    if (inst.op !== "transient_hash") continue;

    const inputVars = inst.inputs as number[] | undefined;
    if (!inputVars) continue;

    const guardedInputs = inputVars.filter((v) => varGuard.has(v));
    if (guardedInputs.length === 0) continue;

    findings.push({
      severity: "info",
      rule: "RT-003",
      instructionIndex: i,
      memoryVar: null,
      message: `transient_hash with ${guardedInputs.length} guarded input(s)`,
      details:
        `JS runtime calls type.toValue() which may truncate trailing zeros ` +
        `(CompactTypeBytes.toValue strips trailing 0x00 bytes). ZKIR receives ` +
        `raw field elements. If guarded inputs default to 0, the hash inputs ` +
        `may differ between JS and ZKIR.`,
    });
  }

  return findings;
};

/**
 * RT-004: Field arithmetic on non-normalized values.
 *
 * JS field arithmetic (addField, subField, mulField) assumes inputs are
 * in [0, FIELD_MODULUS). If an intermediate value escapes this range
 * (e.g., through multiple additions without reduction), JS produces
 * incorrect results while ZKIR's native Fr handles it correctly.
 *
 * Detects: long chains of add/mul without intervening constrain_bits
 * (which force normalization via bit extraction).
 *
 * Example: tests/fixtures/compact/rt-004-long-arithmetic-chain.compact
 */
export const longArithmeticChain: Rule = (graph) => {
  const findings: Finding[] = [];
  const { instructions: insts, instToVar, varToInst, numInputs } = graph;

  // For each constrain_bits target, trace back through arithmetic
  // and count the chain length
  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i]!;
    if (inst.op !== "constrain_bits") continue;

    const targetVar = inst.var as number;
    let chainLength = 0;
    let current = targetVar;

    // Walk backward through arithmetic chain
    while (chainLength < 20) {
      const prodIdx = varToInst.get(current);
      if (prodIdx == null) break;
      const prod = insts[prodIdx]!;
      if (
        prod.op !== "add" &&
        prod.op !== "mul" &&
        prod.op !== "neg"
      ) {
        break;
      }
      chainLength++;
      // Follow first operand
      const ops = getOperands(prod);
      if (ops.length === 0 || ops[0]! < numInputs) break;
      current = ops[0]!;
    }

    if (chainLength >= 8) {
      findings.push({
        severity: "info",
        rule: "RT-004",
        instructionIndex: i,
        memoryVar: targetVar,
        message: `constrain_bits after ${chainLength}-deep arithmetic chain`,
        details:
          `JS field arithmetic assumes inputs are in [0, FIELD_MODULUS) and ` +
          `uses single-reduction shortcuts (e.g., addField subtracts modulus once). ` +
          `Long arithmetic chains without intermediate constraints may accumulate ` +
          `values that escape this range, causing JS/ZKIR divergence. ` +
          `ZKIR uses native Fr which handles arbitrary-depth chains correctly.`,
      });
    }
  }

  return findings;
};

/** All rules in execution order. */
export const ALL_RULES: Rule[] = [
  // Divergence rules (JS/ZK mismatch)
  unconditionalConstrainBits,
  unconditionalReconstituteField,
  unconditionalDivMod,
  unconditionalAssert,
  unconditionalConstrainEq,
  // Runtime divergence rules
  persistentHashGuardedInputs,
  lessThanGuardedOperands,
  transientHashGuardedInputs,
  longArithmeticChain,
  // Stats rules
  deepGuardNesting,
  constraintDensity,
];

// ── Performance rules (run when --profile is enabled) ──

export type PerfRule = (
  profile: import("./types.js").CircuitProfile,
) => Finding[];

/**
 * PERF-001: Circuit too large for WASM proving (hard limit).
 *
 * WASM provers (mobile and desktop browsers) have a hard limit of k=15.
 * Circuits with k > 15 can only be proved by proof servers that have
 * the SRS curve files for that k value. These files are large
 * (k=16: ~500MB, k=20: ~8GB) and must be downloaded before proving.
 * This check always runs, even without --profile.
 */
export const WASM_K_LIMIT = 15;

// SRS curve file sizes from bls_midnight_2p{k} on disk.
// Exact doubling per k: 2^k * 48 bytes (BLS12-381 G1 points).
const SRS_SIZES: Record<number, string> = {
  16: "12MB",
  17: "24MB",
  18: "48MB",
  19: "96MB",
  20: "192MB",
  21: "384MB",
  22: "768MB",
  23: "1.5GB",
  24: "3GB",
  25: "6GB",
};

export function checkWasmKLimit(k: number): Finding | null {
  if (k <= WASM_K_LIMIT) return null;
  const srsSize = SRS_SIZES[k] ?? `>${SRS_SIZES[25] ?? "6GB"}`;
  return {
    severity: "warn",
    rule: "PERF-001",
    instructionIndex: -1,
    memoryVar: null,
    message: `Circuit k=${k} exceeds WASM prover limit (k <= ${WASM_K_LIMIT})`,
    details:
      `This circuit (${(2 ** k).toLocaleString()} rows) cannot be proved in-browser. ` +
      `It requires a proof server with the k=${k} SRS curve file (${srsSize}). ` +
      `Proof servers without this file will fail at proving time.`,
  };
}

/**
 * PERF-003: Circuit requires GPU proving.
 * k >= 20 means the circuit is slow on CPU-based Docker proof servers
 * and benefits from GPU acceleration.
 */
export const gpuRequired: PerfRule = (profile) => {
  if (profile.k < 20) return [];
  return [
    {
      severity: "info",
      rule: "PERF-003",
      instructionIndex: -1,
      memoryVar: null,
      message: `Circuit k=${profile.k} is slow on CPU (k >= 20, consider GPU)`,
      details:
        `At k=${profile.k} (${2 ** profile.k} rows), CPU proving takes ` +
        `60+ seconds. Remote GPU proving services handle this in ` +
        `30-180 seconds depending on k.`,
    },
  ];
};

/**
 * PERF-004: Hash operations dominate circuit size.
 * If >80% of estimated rows come from hash operations, the circuit
 * may benefit from using fewer hashes or a cheaper hash function.
 */
export const hashDominatedCircuit: PerfRule = (profile) => {
  if (profile.rows === 0 || profile.hashCount === 0) return [];
  const hashRatio = profile.hashRows / profile.rows;
  if (hashRatio <= 0.8) return [];
  return [
    {
      severity: "warn",
      rule: "PERF-004",
      instructionIndex: -1,
      memoryVar: null,
      message:
        `Hash ops dominate circuit: ${profile.hashCount} hashes = ` +
        `${(hashRatio * 100).toFixed(0)}% of rows`,
      details:
        `${profile.hashCount} hash operations contribute ${profile.hashRows} ` +
        `of ${profile.rows} estimated rows (${(hashRatio * 100).toFixed(0)}%). ` +
        `Each Poseidon hash costs ~704 rows. Consider reducing the number ` +
        `of hash operations or batching data before hashing.`,
    },
  ];
};

/**
 * PERF-005: Circuit uses lookup tables that inflate k.
 * Lookup tables (from hash gadgets or range checks) force the circuit
 * to have at least 2^k rows where k = ceil(log2(table_rows)).
 */
export const lookupTableInflation: PerfRule = (profile) => {
  if (profile.tableRows <= 256) return [];
  const tableK = Math.ceil(Math.log2(profile.tableRows + 1));
  if (tableK + 1 < profile.k) return [];
  return [
    {
      severity: "info",
      rule: "PERF-005",
      instructionIndex: -1,
      memoryVar: null,
      message:
        `Lookup tables force k >= ${tableK} ` +
        `(${profile.tableRows} table rows)`,
      details:
        `The circuit's lookup tables require ${profile.tableRows} rows, ` +
        `forcing k >= ${tableK} regardless of instruction count. ` +
        `This is common with hash gadgets that use precomputed tables.`,
    },
  ];
};

/**
 * PERF-006: Circuit exceeds user-defined maximum k.
 * Fires when --max-k is set and the circuit's k exceeds it.
 */
export const maxKExceeded: PerfRule = (profile) => {
  if (profile.maxK == null || profile.k <= profile.maxK) return [];
  return [
    {
      severity: "error",
      rule: "PERF-006",
      instructionIndex: -1,
      memoryVar: null,
      message:
        `Circuit k=${profile.k} exceeds maximum k=${profile.maxK} ` +
        `(set via --max-k)`,
      details:
        `The circuit requires 2^${profile.k} = ${(2 ** profile.k).toLocaleString()} rows, ` +
        `but the configured limit is 2^${profile.maxK} = ${(2 ** profile.maxK).toLocaleString()} rows. ` +
        `Reduce circuit complexity or increase --max-k.`,
    },
  ];
};

export const ALL_PERF_RULES: PerfRule[] = [
  maxKExceeded,
  gpuRequired,
  hashDominatedCircuit,
  lookupTableInflation,
];
