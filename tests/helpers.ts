import type { ZkirV2, Instruction } from "../src/types.js";
import { buildIrGraph, type IrGraph } from "../src/ir.js";
import type { Rule } from "../src/rules.js";

export function makeZkir(
  overrides: Partial<ZkirV2> & { instructions: Instruction[] },
): ZkirV2 {
  return {
    version: { major: 2, minor: 0 },
    num_inputs: 0,
    do_communications_commitment: false,
    ...overrides,
  };
}

export function runRule(rule: Rule, zkir: ZkirV2) {
  const graph = buildIrGraph(zkir);
  return rule(graph);
}

export function runRuleOnInstructions(rule: Rule, instructions: Instruction[], numInputs = 0) {
  return runRule(rule, makeZkir({ instructions, num_inputs: numInputs }));
}
