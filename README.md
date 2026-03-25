# compact-zkir-lint

**Your Compact circuit compiled fine. Your tests pass. But the proof server rejects your transaction.**

`compact-zkir-lint` tells you why before your users do.

```bash
npx compact-zkir-lint -r contracts/src/artifacts/
```

```
  addLiquidity (v2): 5 error(s)
    ERROR [DIV-001] constrain_bits(bits=64) on arithmetic in conditional branch (guard=824)
      Fix: move the `as Uint<64>` cast outside the if/else, or use branchless computation.

5 error(s) | 4/11 circuits affected
```

## Compatibility

| Component | Tested versions | Notes |
|-----------|----------------|-------|
| **Compact compiler** | 0.30.0 | ZKIR v2 output. Earlier versions (0.28.0, 0.29.0) produce the same patterns. |
| **compact-runtime** | 0.15.0 | The JS runtime that executes circuits client-side. |
| **ZKIR format** | v2 (`"major": 2`) | What the compiler produces by default. v3 support planned (same bugs exist per compiler FIXMEs). |
| **Ledger** | v8 (ledger-v8 8.0.3) | The proof server and onchain-runtime version. |
| **Node.js** | >= 18 | For running the linter. Zero Midnight package dependencies. |

When new Compact compiler versions ship, re-run the linter against your compiled `.zkir` files. The bugs tracked here ([compact#226](https://github.com/LFDT-Minokawa/compact/issues/226)) exist in the compiler's ZKIR codegen — they persist until the compiler team fixes the `if/else` → `cond_select` lowering. Each compiler release may fix some patterns and introduce others.

## The problem

The Compact compiler generates both JavaScript (for `compact-runtime` client-side execution) and ZKIR (for proof server validation). These two execution paths **diverge**:

- **JS** uses real `if/else` branching — dead branches never execute
- **ZKIR** executes both branches unconditionally — constraints fire on dead-branch values

Narrowing casts (`as Uint<N>`), assertions, and other constraints inside conditional branches fire on values from branches that should be unreachable, causing:

```
BadInput("Bit bound failed: 000000000000000001 is not 64-bit")
```

This was first hit by the LunarSwap team ([compact#250](https://github.com/LFDT-Minokawa/compact/issues/250)) using Compact 0.30.0 + compact-runtime 0.15.0 + ledger-v8. Root cause traced to [compact#226](https://github.com/LFDT-Minokawa/compact/issues/226) — the compiler emits unguarded `ConstrainBits` for dead branches. The compiler source (`compactc/compiler/passes.ss`) contains 4 FIXME comments marking this as a known issue across both ZKIR v2 and v3 codegen.

**Every contract using `as Uint<N>` inside `if/else` is affected.** This includes contracts that depend on OpenZeppelin's `Uint128` math library.

## Install and run

```bash
# Scan a single circuit
npx compact-zkir-lint circuit.zkir

# Scan all circuits in your compiled artifacts
npx compact-zkir-lint -r contracts/src/artifacts/

# Errors only (most actionable)
npx compact-zkir-lint -r contracts/src/artifacts/ --severity error

# CI-friendly: SARIF output, non-zero exit on errors
npx compact-zkir-lint -r contracts/src/artifacts/ --format sarif > results.sarif

# JSON output for programmatic use
npx compact-zkir-lint -r contracts/src/artifacts/ --format json
```

No dependencies on Midnight packages. Reads the `.zkir` JSON files that the compiler already produces. Works offline.

## What it finds

### Errors — will break at proof time

| Rule | Compact versions | What breaks | How to fix |
|------|-----------------|------------|------------|
| **DIV-001** | 0.28.0+ | `as Uint<N>` inside `if/else` generates `constrain_bits` that fires on dead-branch values. Proof server returns "Bit bound failed". Affects **all bit widths** (64, 128, etc). | Move the cast outside the conditional. Use branchless computation (see below). |
| **DIV-002** | 0.28.0+ | `Bytes → Field` conversion inside `if/else`. The `reconstitute_field` instruction has internal constraints that fire unconditionally. Compiler FIXME: `passes.ss:9671`. | Perform the conversion before the branch or after the `cond_select` merge point. |

### Warnings — may break depending on inputs

| Rule | Compact versions | What can break | How to fix |
|------|-----------------|---------------|------------|
| **DIV-003** | 0.28.0+ | `Field → Bytes` conversion inside `if/else`. Compiler FIXME: `passes.ss:9350`. | Move conversion outside the conditional. |
| **DIV-004** | 0.28.0+ | `assert` inside `if/else` fires on dead-branch values. JS skips the assert, ZKIR evaluates it. Proof server returns "Failed direct assertion". | Guard the condition: `assert(cond \|\| !branchGuard)`. Or move assert after the branch merge. |
| **DIV-005** | 0.28.0+ | `constrain_eq` inside `if/else`. Same class as DIV-001 for equality constraints. | Move the equality check outside the conditional. |
| **RT-001** | 0.15.0 runtime | `persistent_hash` with inputs from a conditional branch. ZKIR re-parses field elements through alignment before hashing; JS hashes `AlignedValue` directly. | Hash after the branch merge, not inside the branch. |

### Info — code quality

| Rule | What it flags |
|------|--------------|
| **RT-002** | `less_than` with guarded operands — bit extraction on dead-branch values. |
| **RT-003** | `transient_hash` with guarded inputs — JS `CompactTypeBytes.toValue()` strips trailing zeros, ZKIR uses raw field elements. |
| **RT-004** | Deep arithmetic chains (8+ ops) without intermediate constraints. JS field arithmetic shortcut may not reduce correctly. |
| **STATS-001** | Guard nesting depth >= 4. Deep conditionals multiply divergence risk. |
| **STATS-002** | Constraint density > 25%. May indicate redundant bit constraints. |

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
// BEFORE (broken — Compact 0.30.0): as Uint<64> in else branch
if (borrow == 0) {
    return U128 { low: a.low - b.low, high: highDiff };
} else {
    return U128 { low: (a.low + MODULUS() - b.low) as Uint<64>, high: highDiff };
}

// AFTER (fixed): branchless, cast always safe
const lowDiff = a.low + borrow * MODULUS() - b.low;
return U128 { low: lowDiff as Uint<64>, high: highDiff };
```

## Version tracking

The bugs detected by this tool are in the **Compact compiler's ZKIR codegen**, not in the runtime or proof server. They persist until the compiler team resolves [compact#226](https://github.com/LFDT-Minokawa/compact/issues/226).

| Compiler version | Status | Notes |
|-----------------|--------|-------|
| 0.28.0 | Affected | First version tested with these patterns |
| 0.29.0 | Affected | Same codegen, constraint count regression in some casts ([compact#81](https://github.com/LFDT-Minokawa/compact/issues/81)) |
| 0.30.0 | **Affected** | Current release. All patterns confirmed. LunarSwap hit this in production. |
| 0.31.0 (planned) | Unknown | May switch to ZKIR v3 backend ([compact#86](https://github.com/LFDT-Minokawa/compact/issues/86)). Same FIXMEs exist in v3 codegen (`zkir-v3-passes.ss:672, 765, 782`). |

**When a new compiler version ships:** recompile your contracts, re-run `compact-zkir-lint`, and check if your error count changed. Some fixes may resolve patterns; new compiler features may introduce new ones.

## How it works

1. Parses compiled `.zkir` JSON files (v2 format, zero dependencies)
2. Builds a data-flow graph: which instruction produces which memory variable
3. Tracks guard propagation: which variables are inside conditional branches (from guarded `private_input`/`public_input`)
4. Memoized zero-analysis: determines if dead-branch values default to zero (safe) vs non-zero (dangerous)
5. Flags constraint instructions operating on branch-local values before they reach a `cond_select` merge

## Advanced: differential fuzz testing

For deeper analysis, `compact-zkir-lint` includes a differential testing harness that runs circuits through both `compact-runtime` (JS) and ZKIR preprocessing (WASM). This catches divergences that static analysis can't — but requires the Midnight npm packages (`compact-runtime`, `zkir-v2`).

See [`examples/diff-test-template.ts`](examples/diff-test-template.ts) for the integration pattern, and [`examples/lunarswap-diff-test.ts`](examples/lunarswap-diff-test.ts) for the proven LunarSwap reproduction of compact#250.

## References

- [compact#250](https://github.com/LFDT-Minokawa/compact/issues/250) — Original bug report (LunarSwap addLiquidity)
- [compact#226](https://github.com/LFDT-Minokawa/compact/issues/226) — Compiler tracking issue (assigned, open)
- [compact#253](https://github.com/LFDT-Minokawa/compact/issues/253) — Detailed root cause analysis
- [midnight-apps#309](https://github.com/OpenZeppelin/midnight-apps/pull/309) — Interim fix for Uint128.subU128

## License

Apache-2.0
