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

/** All rules in execution order. */
export const ALL_RULES: Rule[] = [
  unconditionalConstrainBits,
  unconditionalReconstituteField,
  unconditionalDivMod,
  unconditionalAssert,
  unconditionalConstrainEq,
  deepGuardNesting,
  constraintDensity,
];
