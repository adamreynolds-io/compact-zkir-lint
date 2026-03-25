import { describe, it, expect } from "vitest";
import { buildIrGraph, buildZeroAnalysis, guardDepth, getOperands } from "../src/ir.js";
import { makeZkir } from "./helpers.js";

describe("buildIrGraph", () => {
  it("assigns sequential var numbers to producing instructions", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "load_imm", imm: "02" },
        { op: "add", a: 0, b: 1 },
      ],
    });
    const g = buildIrGraph(zkir);
    expect(g.instToVar[0]).toBe(0);
    expect(g.instToVar[1]).toBe(1);
    expect(g.instToVar[2]).toBe(2);
  });

  it("assigns null for non-producing instructions", () => {
    const zkir = makeZkir({
      num_inputs: 1,
      instructions: [
        { op: "constrain_bits", var: 0, bits: 8 },
        { op: "load_imm", imm: "01" },
        { op: "assert", cond: 0 },
      ],
    });
    const g = buildIrGraph(zkir);
    expect(g.instToVar[0]).toBeNull();       // constrain_bits
    expect(g.instToVar[1]).toBe(1);           // load_imm → var 1
    expect(g.instToVar[2]).toBeNull();       // assert
  });

  it("assigns two variables for div_mod_power_of_two", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "FF" },
        { op: "div_mod_power_of_two", var: 0, bits: 4 },
      ],
    });
    const g = buildIrGraph(zkir);
    expect(g.instToVar[1]).toBe(1); // first of two vars
    expect(g.varToInst.get(1)).toBe(1);
    expect(g.varToInst.get(2)).toBe(1); // second var maps to same instruction
  });

  it("tracks guard for guarded private_input", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
      ],
    });
    const g = buildIrGraph(zkir);
    expect(g.varGuard.get(1)).toBe(0);
  });

  it("does not track guard for unguarded private_input", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "private_input", guard: null },
      ],
    });
    const g = buildIrGraph(zkir);
    expect(g.varGuard.has(0)).toBe(false);
  });

  it("propagates guard through add", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },       // var 0 (guard source)
        { op: "private_input", guard: 0 },     // var 1 (guarded)
        { op: "load_imm", imm: "05" },         // var 2 (unguarded)
        { op: "add", a: 1, b: 2 },             // var 3 (inherits guard from var 1)
      ],
    });
    const g = buildIrGraph(zkir);
    expect(g.varGuard.get(3)).toBe(0);
  });

  it("propagates guard through mul", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "load_imm", imm: "03" },
        { op: "mul", a: 1, b: 2 },
      ],
    });
    const g = buildIrGraph(zkir);
    expect(g.varGuard.get(3)).toBe(0);
  });

  it("does not guard cond_select output", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "load_imm", imm: "00" },
        { op: "cond_select", bit: 0, a: 1, b: 2 },
      ],
    });
    const g = buildIrGraph(zkir);
    // cond_select output is NOT guarded — it's a merge point
    expect(g.varGuard.has(3)).toBe(false);
  });

  it("populates condSelectOutputs", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "load_imm", imm: "00" },
        { op: "load_imm", imm: "FF" },
        { op: "cond_select", bit: 0, a: 1, b: 2 },
      ],
    });
    const g = buildIrGraph(zkir);
    expect(g.condSelectOutputs.has(3)).toBe(true);
    expect(g.condSelectOutputs.has(0)).toBe(false);
  });

  it("tracks guard parents for nested guards", () => {
    // Guard parent tracking: a guard G has a parent P if G itself
    // has a varGuard entry (i.e., G was produced inside P's scope).
    // With private_input, the guard field is the guard var, and the
    // OUTPUT var gets a varGuard entry. So guard 1 has no parent
    // (var 1 is unguarded), guard 2 has parent from var 2's guard
    // (var 2 is guarded by 1), etc.
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },           // var 0
        { op: "private_input", guard: null },      // var 1 — used as guard
        { op: "private_input", guard: 1 },         // var 2 — guarded by 1, used as guard
        { op: "private_input", guard: 2 },         // var 3 — guarded by 2
      ],
    });
    const g = buildIrGraph(zkir);
    // Guards used: {1, 2}
    expect(g.guards.has(1)).toBe(true);
    expect(g.guards.has(2)).toBe(true);
    // Guard 2 was used as a guard, and var 2 itself is guarded by 1
    // → guardParents.get(2) should contain 1
    expect(g.guardParents.get(2)?.has(1)).toBe(true);
  });
});

describe("buildZeroAnalysis", () => {
  it("guarded private_input is zero-safe", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
      ],
    });
    const g = buildIrGraph(zkir);
    const isZero = buildZeroAnalysis(g);
    expect(isZero(1)).toBe(true);
  });

  it("mul with one zero-safe operand is zero-safe", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "load_imm", imm: "FF" },
        { op: "mul", a: 1, b: 2 },
      ],
    });
    const g = buildIrGraph(zkir);
    const isZero = buildZeroAnalysis(g);
    expect(isZero(3)).toBe(true); // 0 * anything = 0
  });

  it("add with non-zero-safe operand is NOT zero-safe", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: 0 },
        { op: "add", a: 1, b: 0 },
      ],
    });
    const g = buildIrGraph(zkir);
    const isZero = buildZeroAnalysis(g);
    // var 0 is load_imm (not guarded, not an input) → not zero-safe
    // add requires ALL operands zero-safe or inputs → false
    expect(isZero(2)).toBe(false);
  });

  it("unguarded variable is not zero-safe", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: null },
      ],
    });
    const g = buildIrGraph(zkir);
    const isZero = buildZeroAnalysis(g);
    expect(isZero(0)).toBe(false);
    expect(isZero(1)).toBe(false);
  });
});

describe("guardDepth", () => {
  it("single guard returns 1", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: null },
        { op: "private_input", guard: 1 },
      ],
    });
    const g = buildIrGraph(zkir);
    expect(guardDepth(g, 1)).toBe(1);
  });

  it("nested guards return correct depth", () => {
    const zkir = makeZkir({
      instructions: [
        { op: "load_imm", imm: "01" },
        { op: "private_input", guard: null },
        { op: "private_input", guard: 1 },
        { op: "private_input", guard: 2 },
        { op: "private_input", guard: 3 },
      ],
    });
    const g = buildIrGraph(zkir);
    expect(guardDepth(g, 1)).toBe(1);
    expect(guardDepth(g, 2)).toBe(2);
    expect(guardDepth(g, 3)).toBe(3);
  });
});

describe("getOperands", () => {
  it("extracts a and b from add", () => {
    expect(getOperands({ op: "add", a: 3, b: 5 })).toEqual([3, 5]);
  });

  it("extracts a from neg", () => {
    expect(getOperands({ op: "neg", a: 7 })).toEqual([7]);
  });

  it("does not include var field for constrain_bits", () => {
    expect(getOperands({ op: "constrain_bits", var: 2, bits: 64 })).toEqual([]);
  });

  it("includes var field for copy", () => {
    expect(getOperands({ op: "copy", var: 4 })).toEqual([4]);
  });
});
