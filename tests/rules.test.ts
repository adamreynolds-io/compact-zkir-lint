import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildIrGraph } from "../src/ir.js";
import {
  unconditionalConstrainBits,
  unconditionalReconstituteField,
  unconditionalDivMod,
  unconditionalAssert,
  unconditionalConstrainEq,
  persistentHashGuardedInputs,
  lessThanGuardedOperands,
  transientHashGuardedInputs,
  longArithmeticChain,
  deepGuardNesting,
  constraintDensity,
} from "../src/rules.js";
import { makeZkir, runRule } from "./helpers.js";

const FIXTURES = join(import.meta.dirname, "fixtures/real");

describe("DIV-001: unconditionalConstrainBits", () => {
  it("flags constrain_bits on guarded arithmetic result", () => {
    const findings = runRule(unconditionalConstrainBits, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "add", a: 1, b: 0 },
        { op: "constrain_bits", var: 2, bits: 64 },
      ],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("DIV-001");
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.memoryVar).toBe(2);
  });

  it("does not flag constrain_bits on unguarded value", () => {
    const findings = runRule(unconditionalConstrainBits, makeZkir({
      num_inputs: 1,
      instructions: [
        { op: "private_input", guard: null },
        { op: "constrain_bits", var: 1, bits: 64 },
      ],
    }));
    expect(findings).toHaveLength(0);
  });

  it("does not flag constrain_bits on cond_select output", () => {
    const findings = runRule(unconditionalConstrainBits, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "load_imm", imm: "00" },
        { op: "cond_select", bit: 0, a: 1, b: 2 },
        { op: "constrain_bits", var: 3, bits: 64 },
      ],
    }));
    expect(findings).toHaveLength(0);
  });

  it("does not flag constrain_bits on zero-safe mul result", () => {
    const findings = runRule(unconditionalConstrainBits, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "load_imm", imm: "FF" },
        { op: "mul", a: 1, b: 2 },
        { op: "constrain_bits", var: 3, bits: 64 },
      ],
    }));
    expect(findings).toHaveLength(0);
  });

  it("finds error in real micro-dao cashOut circuit", () => {
    const zkir = JSON.parse(readFileSync(join(FIXTURES, "micro-dao-cashOut.zkir"), "utf-8"));
    const graph = buildIrGraph(zkir);
    const findings = unconditionalConstrainBits(graph);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const f = findings[0]!;
    expect(f.rule).toBe("DIV-001");
    expect(f.severity).toBe("error");
    expect(f.memoryVar).toBe(51);
  });
});

describe("DIV-002: unconditionalReconstituteField", () => {
  it("flags reconstitute_field with guarded operand", () => {
    const findings = runRule(unconditionalReconstituteField, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "reconstitute_field", divisor: 1, modulus: 0, bits: 8 },
      ],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("DIV-002");
    expect(findings[0]!.severity).toBe("error");
  });

  it("does not flag reconstitute_field with unguarded operands", () => {
    const findings = runRule(unconditionalReconstituteField, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: null },
        { op: "reconstitute_field", divisor: 1, modulus: 0, bits: 8 },
      ],
    }));
    expect(findings).toHaveLength(0);
  });
});

describe("DIV-003: unconditionalDivMod", () => {
  it("flags div_mod_power_of_two on guarded input", () => {
    const findings = runRule(unconditionalDivMod, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "div_mod_power_of_two", var: 1, bits: 8 },
      ],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("DIV-003");
    expect(findings[0]!.severity).toBe("warn");
  });

  it("does not flag div_mod_power_of_two on unguarded input", () => {
    const findings = runRule(unconditionalDivMod, makeZkir({
      instructions: [
        { op: "load_imm", imm: "FF" },
        { op: "div_mod_power_of_two", var: 0, bits: 4 },
      ],
    }));
    expect(findings).toHaveLength(0);
  });
});

describe("DIV-004: unconditionalAssert", () => {
  it("flags assert on guarded branch-local value", () => {
    const findings = runRule(unconditionalAssert, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "test_eq", a: 1, b: 0 },
        { op: "assert", cond: 2 },
      ],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("DIV-004");
    expect(findings[0]!.severity).toBe("warn");
  });

  it("does not flag assert on unguarded value", () => {
    const findings = runRule(unconditionalAssert, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: null },
        { op: "test_eq", a: 1, b: 0 },
        { op: "assert", cond: 2 },
      ],
    }));
    expect(findings).toHaveLength(0);
  });

  it("does not flag assert on cond_select output", () => {
    const findings = runRule(unconditionalAssert, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "test_eq", a: 1, b: 0 },
        { op: "load_imm", imm: "01" },
        { op: "cond_select", bit: 0, a: 2, b: 3 },
        { op: "assert", cond: 4 },
      ],
    }));
    expect(findings).toHaveLength(0);
  });
});

describe("DIV-005: unconditionalConstrainEq", () => {
  it("flags constrain_eq with guarded operand", () => {
    const findings = runRule(unconditionalConstrainEq, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "load_imm", imm: "05" },
        { op: "constrain_eq", a: 1, b: 2 },
      ],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("DIV-005");
    expect(findings[0]!.severity).toBe("warn");
  });

  it("does not flag constrain_eq with unguarded operands", () => {
    const findings = runRule(unconditionalConstrainEq, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: null },
        { op: "load_imm", imm: "05" },
        { op: "constrain_eq", a: 1, b: 2 },
      ],
    }));
    expect(findings).toHaveLength(0);
  });
});

describe("RT-001: persistentHashGuardedInputs", () => {
  it("flags persistent_hash with guarded input", () => {
    const findings = runRule(persistentHashGuardedInputs, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "load_imm", imm: "AB" },
        { op: "persistent_hash", alignment: [], inputs: [1, 2] },
      ],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("RT-001");
    expect(findings[0]!.message).toContain("1 guarded input");
  });

  it("does not flag persistent_hash with unguarded inputs", () => {
    const findings = runRule(persistentHashGuardedInputs, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: null },
        { op: "persistent_hash", alignment: [], inputs: [0, 1] },
      ],
    }));
    expect(findings).toHaveLength(0);
  });
});

describe("RT-002: lessThanGuardedOperands", () => {
  it("flags less_than with guarded operand", () => {
    const findings = runRule(lessThanGuardedOperands, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "load_imm", imm: "0A" },
        { op: "less_than", a: 1, b: 2, bits: 32 },
      ],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("RT-002");
    expect(findings[0]!.severity).toBe("info");
  });

  it("does not flag less_than with unguarded operands", () => {
    const findings = runRule(lessThanGuardedOperands, makeZkir({
      instructions: [
        { op: "load_imm", imm: "05" },
        { op: "load_imm", imm: "0A" },
        { op: "less_than", a: 0, b: 1, bits: 32 },
      ],
    }));
    expect(findings).toHaveLength(0);
  });
});

describe("RT-003: transientHashGuardedInputs", () => {
  it("flags transient_hash with guarded input", () => {
    const findings = runRule(transientHashGuardedInputs, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "transient_hash", inputs: [1] },
      ],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("RT-003");
    expect(findings[0]!.severity).toBe("info");
  });

  it("does not flag transient_hash with unguarded inputs", () => {
    const findings = runRule(transientHashGuardedInputs, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: null },
        { op: "transient_hash", inputs: [1] },
      ],
    }));
    expect(findings).toHaveLength(0);
  });
});

describe("RT-004: longArithmeticChain", () => {
  it("flags 8-deep arithmetic chain", () => {
    const findings = runRule(longArithmeticChain, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "load_imm", imm: "02" },
        { op: "add", a: 1, b: 0 },
        { op: "add", a: 2, b: 0 },
        { op: "add", a: 3, b: 0 },
        { op: "add", a: 4, b: 0 },
        { op: "add", a: 5, b: 0 },
        { op: "add", a: 6, b: 0 },
        { op: "add", a: 7, b: 0 },
        { op: "add", a: 8, b: 0 },
        { op: "constrain_bits", var: 9, bits: 64 },
      ],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("RT-004");
    expect(findings[0]!.severity).toBe("info");
  });

  it("does not flag short chain", () => {
    const findings = runRule(longArithmeticChain, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "load_imm", imm: "02" },
        { op: "add", a: 1, b: 0 },
        { op: "add", a: 2, b: 0 },
        { op: "add", a: 3, b: 0 },
        { op: "constrain_bits", var: 4, bits: 64 },
      ],
    }));
    expect(findings).toHaveLength(0);
  });
});

describe("STATS-001: deepGuardNesting", () => {
  it("flags guard with depth >= 4", () => {
    // Need 4 levels: each guard must be USED as a guard AND itself be guarded.
    // private_input(guard: N) uses N as a guard and produces a guarded var.
    // The output var must then be used as a guard by the next instruction.
    const findings = runRule(deepGuardNesting, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },           // var 0
        { op: "private_input", guard: null },      // var 1 — guard level 1
        { op: "private_input", guard: 1 },         // var 2 — guard level 2
        { op: "private_input", guard: 2 },         // var 3 — guard level 3
        { op: "private_input", guard: 3 },         // var 4 — guard level 4
        { op: "private_input", guard: 4 },         // var 5 — uses guard 4 (depth 4)
      ],
    }));
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some(f => f.rule === "STATS-001")).toBe(true);
  });

  it("does not flag shallow nesting", () => {
    const findings = runRule(deepGuardNesting, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: null },
        { op: "private_input", guard: 1 },
      ],
    }));
    expect(findings).toHaveLength(0);
  });
});

describe("STATS-002: constraintDensity", () => {
  it("flags high constraint density (>25%)", () => {
    const findings = runRule(constraintDensity, makeZkir({
      num_inputs: 1,
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "constrain_bits", var: 0, bits: 8 },
        { op: "constrain_bits", var: 0, bits: 16 },
      ],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("STATS-002");
  });

  it("does not flag low constraint density", () => {
    const findings = runRule(constraintDensity, makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "load_imm", imm: "02" },
        { op: "load_imm", imm: "03" },
        { op: "load_imm", imm: "04" },
        { op: "load_imm", imm: "05" },
        { op: "load_imm", imm: "06" },
        { op: "load_imm", imm: "07" },
        { op: "load_imm", imm: "08" },
        { op: "load_imm", imm: "09" },
        { op: "constrain_bits", var: 0, bits: 8 },
      ],
    }));
    expect(findings).toHaveLength(0);
  });
});
