# Differential Fuzz Testing

Static analysis ([rules reference](../rules/README.md)) catches known divergence patterns. Differential testing catches divergences that static analysis can't — by running circuits through both `compact-runtime` (JS) and ZKIR preprocessing (WASM) and comparing the results.

If JS succeeds but ZKIR fails, you've found a divergence bug.

## Prerequisites

Differential testing requires the Midnight npm packages (the linter itself has zero dependencies):

```bash
npm install @midnight-ntwrk/compact-runtime @midnight-ntwrk/zkir-v2
```

## How it works

The pipeline mirrors the proof server's validation:

```
Compact circuit call (JS)
  → ProofData
    → proofDataIntoSerializedPreimage()
      → checkV2() (WASM — same code as proof server /check endpoint)
        → IrSource::check() → preprocess() → resolve_operand_bits()
```

If `checkV2()` throws but the JS circuit returned successfully, the contract has a divergence bug that will fail in production.

## Quick start

Use the template at [`examples/diff-test-template.ts`](../../examples/diff-test-template.ts):

1. Copy it into your contract's test directory
2. Import your contract and witness implementation
3. Call circuits with test inputs
4. Pass the `proofData` from each circuit call to `checkProofDataAgainstZkir()`

```typescript
import { checkProofDataAgainstZkir, createRawContract } from './diff-test-template.js';

const { callCircuit } = createRawContract(MyContract, witnesses, privateState, []);
const result = callCircuit('myCircuit', arg1, arg2);

// This throws if ZKIR rejects the proof data
await checkProofDataAgainstZkir(CONTRACT_DIR, 'myCircuit', result.proofData);
```

## Real-world example: LunarSwap

[`examples/lunarswap-diff-test.ts`](../../examples/lunarswap-diff-test.ts) reproduces [compact#250](https://github.com/LFDT-Minokawa/compact/issues/250) — the original LunarSwap `addLiquidity` divergence. It exercises:

- Basic liquidity provision
- Second provision (triggers `subU128` in `Uint128_div` verification)
- Equal amounts (`a.low == b.low` case in `subU128`)
- Large amounts (stress `Uint128` math)
- Asymmetric reserves

Each test calls the JS circuit, then validates the ProofData against ZKIR. The `subU128` cases fail with `BadInput("Bit bound failed")` — confirming the [DIV-001](../rules/DIV-001.md) pattern.

## Fuzz input generation

The linter includes ZKIR-guided input generation ([`src/fuzz.ts`](../../src/fuzz.ts)) that targets branch boundaries. Instead of random inputs, it generates values that exercise:

- Guard conditions (values that flip branch selection)
- Bit boundaries (values near 2^N for constrain_bits checks)
- Field arithmetic edge cases (values near FIELD_MODULUS)

Combine with the differential harness for targeted coverage:

```typescript
import { generateFuzzInputs } from 'compact-zkir-lint';

const inputs = generateFuzzInputs('path/to/circuit.zkir', { count: 100 });
for (const input of inputs) {
  const result = callCircuit('myCircuit', ...input);
  await checkProofDataAgainstZkir(CONTRACT_DIR, 'myCircuit', result.proofData);
}
```

## Limitations

- Requires Midnight npm packages (`compact-runtime`, `zkir-v2`) — not available in all environments
- Only catches divergences for the specific inputs tested — not exhaustive
- Does not test the full proof generation pipeline (no prover/verifier keys)
- WASM `checkV2` must match the proof server version you're targeting
