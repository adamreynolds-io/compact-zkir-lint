# zkir-lint

**Your Compact circuit compiled fine. Your tests pass. But the proof server rejects your transaction.**

`zkir-lint` tells you why before your users do.

```bash
npx zkir-lint -r contracts/src/artifacts/
```

```
  addLiquidity (v2): 5 error(s)
    ERROR [DIV-001] constrain_bits(bits=64) on arithmetic in conditional branch (guard=824)
      Fix: move the `as Uint<64>` cast outside the if/else, or use branchless computation.

5 error(s) | 4/11 circuits affected
```

## The problem

Compact compiler 0.30.0 + compact-runtime 0.15.0 have a known class of bugs where **your circuit works perfectly in JavaScript but fails at proof time**. The JS runtime uses real `if/else` branching, but ZK circuits execute both branches unconditionally. Narrowing casts (`as Uint<N>`), assertions, and other constraints inside conditional branches fire on dead-branch values, causing:

```
BadInput("Bit bound failed: 000000000000000001 is not 64-bit")
```

This was first hit by the LunarSwap team ([compact#250](https://github.com/LFDT-Minokawa/compact/issues/250)) and traced to a [compiler bug](https://github.com/LFDT-Minokawa/compact/issues/226) with no timeline for a fix. **Every contract using `as Uint<N>` inside `if/else` is affected.**

## Install and run

```bash
# Scan a single circuit
npx zkir-lint circuit.zkir

# Scan all circuits in your compiled artifacts
npx zkir-lint -r contracts/src/artifacts/

# Errors only (most actionable)
npx zkir-lint -r contracts/src/artifacts/ --severity error

# CI-friendly: SARIF output, non-zero exit on errors
npx zkir-lint -r contracts/src/artifacts/ --format sarif > results.sarif

# JSON output for programmatic use
npx zkir-lint -r contracts/src/artifacts/ --format json
```

No dependencies on Midnight packages. Reads the `.zkir` JSON files that the compiler already produces.

## What it finds

### Errors — will break at proof time

| Rule | What breaks | How to fix |
|------|------------|------------|
| **DIV-001** | `as Uint<N>` inside `if/else` generates `constrain_bits` that fires on dead-branch values. Your proof server returns "Bit bound failed". | Move the cast outside the conditional. Use branchless computation (see below). |
| **DIV-002** | `Bytes → Field` conversion inside `if/else`. The `reconstitute_field` instruction has internal constraints that fire unconditionally. | Perform the conversion before the branch or after the `cond_select` merge point. |

### Warnings — may break depending on inputs

| Rule | What can break | How to fix |
|------|---------------|------------|
| **DIV-003** | `Field → Bytes` conversion inside `if/else`. Same pattern as DIV-002 but for the reverse direction. | Move conversion outside the conditional. |
| **DIV-004** | `assert` inside `if/else` fires on dead-branch values. JS skips the assert (branch not taken), but ZKIR evaluates it. You get "Failed direct assertion" from the proof server. | Guard the assertion condition: `assert(condition \|\| !branchGuard)`. Or restructure so the assert is after the `cond_select`. |
| **DIV-005** | `constrain_eq` inside `if/else`. Same class as DIV-001 but for equality constraints. | Move the equality check outside the conditional. |
| **RT-001** | `persistent_hash` with inputs from a conditional branch. ZKIR re-parses field elements through alignment before hashing; JS hashes `AlignedValue` directly. Different code paths may produce different hash inputs. | Ensure hash inputs are not from guarded regions, or hash after the branch merge. |

### Info — code quality

| Rule | What it flags |
|------|--------------|
| **RT-002** | `less_than` with guarded operands — bit extraction on dead-branch values. |
| **RT-003** | `transient_hash` with guarded inputs — JS `CompactTypeBytes.toValue()` strips trailing zeros, ZKIR uses raw field elements. |
| **RT-004** | Deep arithmetic chains (8+ operations) without intermediate constraints. JS field arithmetic uses a single-subtraction shortcut that may not reduce correctly for long chains. |
| **STATS-001** | Guard nesting depth >= 4. Deep conditionals multiply divergence risk. |
| **STATS-002** | Constraint density > 25%. May indicate redundant bit constraints from the compiler. |

## How to fix DIV-001 (the most common issue)

The pattern that breaks:

```compact
if (condition) {
    const x = someComputation();
    return x as Uint<64>;  // constrain_bits(64) fires even when condition is false
} else {
    return 0;
}
```

**Fix: branchless computation.** Move the narrowing cast outside the branch:

```compact
// Compute both branches, select result, THEN cast
const ifResult = someComputation();
const result = condition ? ifResult : 0;
return result as Uint<64>;  // constrain_bits on the SELECTED value — always safe
```

Or use arithmetic to avoid branching entirely:

```compact
// Instead of if/else with cast in one branch:
const result = baseValue + condition * adjustment;
return result as Uint<64>;  // always safe because result is always in range
```

Real example from [OpenZeppelin Uint128.subU128](https://github.com/OpenZeppelin/midnight-apps/pull/309):

```compact
// BEFORE (broken): as Uint<64> in else branch
if (borrow == 0) {
    return U128 { low: a.low - b.low, high: highDiff };
} else {
    return U128 { low: (a.low + MODULUS() - b.low) as Uint<64>, high: highDiff };
}

// AFTER (fixed): branchless, cast always safe
const lowDiff = a.low + borrow * MODULUS() - b.low;
return U128 { low: lowDiff as Uint<64>, high: highDiff };
```

## Affected versions

- **Compact compiler:** 0.30.0 (and likely earlier versions)
- **compact-runtime:** 0.15.0
- **ZKIR format:** v2 (v3 has the same issue per compiler source FIXMEs)
- **Tracking issue:** [compact#226](https://github.com/LFDT-Minokawa/compact/issues/226) (open, assigned)

## How it works

1. Parses compiled `.zkir` JSON (v2 format, zero Midnight dependencies)
2. Builds a data-flow graph: which instruction produces which variable
3. Tracks guard propagation: which variables are inside conditional branches
4. Memoized zero-analysis: determines if dead-branch values default to zero (safe) vs non-zero (dangerous)
5. Flags constraint instructions operating on branch-local values before they reach a `cond_select` merge

## Advanced: differential fuzz testing

For deeper analysis, zkir-lint includes a differential testing harness that runs circuits through both `compact-runtime` (JS) and ZKIR preprocessing (WASM). This catches divergences that static analysis can't — but requires the Midnight npm packages.

See [`examples/diff-test-template.ts`](examples/diff-test-template.ts) for the integration pattern, and [`examples/lunarswap-diff-test.ts`](examples/lunarswap-diff-test.ts) for the proven LunarSwap reproduction of compact#250.

## License

Apache-2.0
