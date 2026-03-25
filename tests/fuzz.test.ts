import { describe, it, expect } from "vitest";
import {
  extractInputConstraints,
  extractBranchConditions,
  generateFuzzInputs,
  generateBranchTargetInputs,
} from "../src/fuzz.js";
import type { ZkirV2 } from "../src/types.js";
import { makeZkir } from "./helpers.js";

describe("extractInputConstraints", () => {
  it("finds constrain_bits on input variables", () => {
    const zkir = makeZkir({
      num_inputs: 2,
      instructions: [
        { op: "constrain_bits", var: 0, bits: 8 },
        { op: "constrain_bits", var: 1, bits: 128 },
      ],
    });
    const constraints = extractInputConstraints(zkir);
    expect(constraints).toHaveLength(2);
    expect(constraints[0]).toEqual({ inputIndex: 0, maxBits: 8 });
    expect(constraints[1]).toEqual({ inputIndex: 1, maxBits: 128 });
  });

  it("fills unconstrained inputs with 253 bits", () => {
    const zkir = makeZkir({
      num_inputs: 3,
      instructions: [
        { op: "constrain_bits", var: 0, bits: 64 },
      ],
    });
    const constraints = extractInputConstraints(zkir);
    expect(constraints).toHaveLength(3);
    expect(constraints.find(c => c.inputIndex === 0)!.maxBits).toBe(64);
    expect(constraints.find(c => c.inputIndex === 1)!.maxBits).toBe(253);
    expect(constraints.find(c => c.inputIndex === 2)!.maxBits).toBe(253);
  });

  it("ignores constrain_bits on non-input variables", () => {
    const zkir = makeZkir({
      num_inputs: 1,
      instructions: [
        { op: "load_imm", imm: "FF" },
        { op: "constrain_bits", var: 1, bits: 32 },
      ],
    });
    const constraints = extractInputConstraints(zkir);
    expect(constraints).toHaveLength(1);
    expect(constraints[0]!.inputIndex).toBe(0);
    expect(constraints[0]!.maxBits).toBe(253); // unconstrained
  });
});

describe("extractBranchConditions", () => {
  it("finds test_eq used in cond_select", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "load_imm", imm: "02" },
        { op: "test_eq", a: 0, b: 1 },
        { op: "load_imm", imm: "AA" },
        { op: "load_imm", imm: "BB" },
        { op: "cond_select", bit: 2, a: 3, b: 4 },
      ],
    });
    const conditions = extractBranchConditions(zkir);
    expect(conditions.length).toBeGreaterThanOrEqual(1);
    expect(conditions[0]!.op).toBe("test_eq");
  });

  it("finds less_than used in cond_select", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "load_imm", imm: "02" },
        { op: "less_than", a: 0, b: 1, bits: 8 },
        { op: "load_imm", imm: "AA" },
        { op: "load_imm", imm: "BB" },
        { op: "cond_select", bit: 2, a: 3, b: 4 },
      ],
    });
    const conditions = extractBranchConditions(zkir);
    expect(conditions.length).toBeGreaterThanOrEqual(1);
    expect(conditions[0]!.op).toBe("less_than");
    expect(conditions[0]!.bits).toBe(8);
  });
});

describe("generateFuzzInputs", () => {
  it("first input is zero vector", () => {
    const zkir = makeZkir({
      num_inputs: 3,
      instructions: [
        { op: "constrain_bits", var: 0, bits: 8 },
        { op: "constrain_bits", var: 1, bits: 16 },
        { op: "constrain_bits", var: 2, bits: 32 },
      ],
    });
    const inputs = generateFuzzInputs(zkir, 50);
    expect(inputs[0]!.strategy).toBe("zero");
    expect(inputs[0]!.values).toEqual([0n, 0n, 0n]);
  });

  it("second input is max vector", () => {
    const zkir = makeZkir({
      num_inputs: 2,
      instructions: [
        { op: "constrain_bits", var: 0, bits: 8 },
        { op: "constrain_bits", var: 1, bits: 16 },
      ],
    });
    const inputs = generateFuzzInputs(zkir, 50);
    expect(inputs[1]!.strategy).toBe("max");
    expect(inputs[1]!.values[0]).toBe(255n);       // 2^8 - 1
    expect(inputs[1]!.values[1]).toBe(65535n);      // 2^16 - 1
  });

  it("respects count limit", () => {
    const zkir = makeZkir({
      num_inputs: 1,
      instructions: [{ op: "constrain_bits", var: 0, bits: 8 }],
    });
    const inputs = generateFuzzInputs(zkir, 5);
    expect(inputs.length).toBeLessThanOrEqual(5);
  });

  it("produces boundary values for each input", () => {
    const zkir = makeZkir({
      num_inputs: 1,
      instructions: [{ op: "constrain_bits", var: 0, bits: 8 }],
    });
    const inputs = generateFuzzInputs(zkir, 50);
    const boundaryInputs = inputs.filter(i => i.strategy === "boundary");
    const boundaryValues = boundaryInputs.map(i => i.values[0]);
    expect(boundaryValues).toContain(0n);
    expect(boundaryValues).toContain(1n);
    expect(boundaryValues).toContain(254n);  // max - 1
    expect(boundaryValues).toContain(255n);  // max
  });

  it("handles 0-input circuit", () => {
    const zkir = makeZkir({
      num_inputs: 0,
      instructions: [{ op: "load_imm", imm: "01" }],
    });
    const inputs = generateFuzzInputs(zkir, 5);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[0]!.values).toEqual([]);
  });
});

describe("generateBranchTargetInputs", () => {
  it("generates inputs for test_eq with direct input operand", () => {
    const zkir = makeZkir({ num_inputs: 1, instructions: [] });
    const inputs = generateBranchTargetInputs(zkir, {
      op: "test_eq",
      operands: [0],
    });
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(inputs.some(i => i.strategy === "branch-true")).toBe(true);
    expect(inputs.some(i => i.strategy === "branch-false")).toBe(true);
  });

  it("generates boundary inputs for less_than", () => {
    const zkir = makeZkir({ num_inputs: 1, instructions: [] });
    const inputs = generateBranchTargetInputs(zkir, {
      op: "less_than",
      operands: [0],
      bits: 8,
    });
    expect(inputs.length).toBeGreaterThanOrEqual(2);
  });
});
