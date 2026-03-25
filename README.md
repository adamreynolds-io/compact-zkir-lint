# zkir-lint

Static analyzer for [Compact](https://docs.midnight.network/compact) ZKIR files. Detects JS/ZK divergence patterns where `compact-runtime` (JavaScript) succeeds but ZKIR proof validation fails.

## Background

The Compact compiler generates both JavaScript (for client-side circuit execution via `compact-runtime`) and ZKIR (for ZK proof generation/validation). These two execution paths can diverge — the JS succeeds but the proof server rejects the proof. This tool statically analyzes compiled `.zkir` files to find known divergence patterns without running any code.

Developed during the investigation of [LFDT-Minokawa/compact#250](https://github.com/LFDT-Minokawa/compact/issues/250) and [#226](https://github.com/LFDT-Minokawa/compact/issues/226).

## Usage

```bash
# Single file
npx tsx src/cli.ts circuit.zkir

# Recursive scan
npx tsx src/cli.ts -r contracts/src/artifacts/

# Errors only, quiet summary
npx tsx src/cli.ts -r . --severity error -q

# SARIF output for CI
npx tsx src/cli.ts -r . --format sarif > results.sarif

# JSON output
npx tsx src/cli.ts -r . --format json > results.json
```

## Rules

| Rule | Severity | Description |
|------|----------|-------------|
| **DIV-001** | error | `constrain_bits` on arithmetic result in conditional branch. The [#226 pattern](https://github.com/LFDT-Minokawa/compact/issues/226): `as Uint<N>` inside `if/else` generates an unguarded constraint that fires on dead-branch values. |
| **DIV-002** | error | `reconstitute_field` in conditional branch. Compiler FIXME: `passes.ss:9671` "zkir bytes->field needs to respect test". |
| **DIV-003** | warn | `div_mod_power_of_two` in conditional branch. Compiler FIXME: `passes.ss:9350` "zkir field->bytes needs to respect test". |
| **DIV-004** | warn | `assert` on branch-local value. Fires unconditionally in ZK even when the branch is logically unreachable. |
| **DIV-005** | warn | `constrain_eq` in conditional branch. Same class as DIV-001 but for equality constraints. |
| **STATS-001** | info | Guard nesting depth >= 4. Deep conditionals multiply divergence risk. |
| **STATS-002** | info | Constraint density > 25%. May indicate redundant bit constraints. |

## How it works

1. Parses ZKIR v2 JSON files (v3 support planned)
2. Builds a data-flow graph mapping each instruction to the memory variable it produces
3. Tracks which variables are under branch guards (from guarded `private_input`/`public_input`)
4. Propagates guard information through arithmetic operations
5. Uses memoized zero-analysis: determines if a variable is guaranteed to be 0 when its guard is false (safe) vs potentially non-zero (dangerous)
6. Flags constraint instructions (`constrain_bits`, `reconstitute_field`, `assert`, `constrain_eq`) that operate on branch-local values not yet merged by `cond_select`

## Example output

```
zkir-lint: scanned 217 file(s)

  addLiquidity (v2): 5 error(s), 259 warning(s)
    10296 instructions, 17 inputs, 1678 constrain_bits, 1827 cond_select, 14 guarded regions (max depth 2)
    ERROR [DIV-001] inst 5029: constrain_bits(var=3059, bits=64) on arithmetic result in guarded region (guard=2603)
    ERROR [DIV-001] inst 5754: constrain_bits(var=3542, bits=64) on arithmetic result in guarded region (guard=3085)
    ...

401 error(s), 612 warning(s), 4 info(s) | 208/217 clean
```

## Workaround for DIV-001

Until the compiler fix ([#226](https://github.com/LFDT-Minokawa/compact/issues/226)) lands, avoid narrowing casts (`as Uint<N>`) inside conditional branches. Use branchless computation instead:

```compact
// Instead of:
if (borrow == 0) {
    return U128 { low: a.low - b.low, high: highDiff };
} else {
    return U128 { low: (a.low + MODULUS() - b.low) as Uint<64>, high: highDiff };
}

// Use branchless:
const lowDiff = a.low + borrow * MODULUS() - b.low;
return U128 { low: lowDiff as Uint<64>, high: highDiff };
```

## Differential Fuzz Testing

Beyond static analysis, zkir-lint includes a differential testing harness that runs circuits through both `compact-runtime` (JS) and ZKIR preprocessing (WASM) to find divergences with concrete inputs.

### Architecture

```
                    ┌─────────────────┐
  Fuzz Inputs ───▶  │  compact-runtime │──▶ ProofData (JS succeeds)
  (generated        │  (BigInt, real   │         │
   from ZKIR)       │   branching)     │         ▼
                    └─────────────────┘   ┌─────────────────┐
                                          │ proofDataInto    │
                                          │ SerializedPre-   │──▶ ProofPreimage
                                          │ image() [WASM]   │         │
                                          └─────────────────┘         ▼
                                                              ┌─────────────────┐
                                                              │ checkV2/checkV3  │
                                                              │ [WASM: ir_vm.rs  │
                                                              │  preprocess()]   │
                                                              └────────┬────────┘
                                                                       │
                                                         JS pass + ZKIR fail = DIVERGENCE
```

### Input Generation

The fuzz input generator parses ZKIR to extract:
- Input count and bit-width constraints from `constrain_bits`
- Branch conditions from `test_eq` and `less_than` instructions
- Boundary values (0, 1, max-1, max) for each constrained input

```typescript
import { generateFuzzInputs, extractBranchConditions } from 'zkir-lint';

const zkir = JSON.parse(readFileSync('circuit.zkir', 'utf-8'));
const inputs = generateFuzzInputs(zkir, 100);  // 100 fuzz inputs
const branches = extractBranchConditions(zkir); // branch-targeted inputs
```

### Harness Integration

Wire up with your compiled Compact contract:

```typescript
import { createHarness, fuzzCircuit } from 'zkir-lint';
import { Contract } from './artifacts/MyContract/contract/index.js';
import { checkProofData } from '@compact/test-center/key-provider.js';

const harness = createHarness({
  contractDir: './artifacts/MyContract',
  contract: new Contract(witnesses),
  initialState: (c) => c.initialState(ctx, ...args),
  createContext: (cs, ps, cpk) => createCircuitContext(...),
  checkProofData: (name, pd) => checkProofData(dir, name, pd),
});

const results = await fuzzCircuit(harness, 'myCircuit', {
  inputs: generateFuzzInputs(zkir, 100),
  verbose: true,
  resetBetweenRuns: true,
});

if (results.divergences > 0) {
  console.error(formatDiffSummary(results));
  // JS succeeded but ZKIR failed — divergence found!
}
```

### Components

| Module | Purpose |
|--------|---------|
| `src/fuzz.ts` | ZKIR-guided input generation (boundary, branch-targeted, random) |
| `src/diff.ts` | Differential test runner (JS vs ZKIR comparison engine) |
| `src/harness.ts` | Test harness factory (wires contract + runtime + ZKIR check) |
| `examples/lunarswap-fuzz.ts` | Concrete example with LunarSwap |

## License

Apache-2.0
