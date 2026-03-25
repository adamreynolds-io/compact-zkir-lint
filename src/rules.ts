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
