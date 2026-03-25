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

## Install and run

```bash
# Scan a single circuit
npx compact-zkir-lint circuit.zkir

# Scan all circuits in your compiled artifacts
npx compact-zkir-lint -r contracts/src/artifacts/

# CI-friendly: SARIF output, non-zero exit on errors
npx compact-zkir-lint -r contracts/src/artifacts/ --format sarif > results.sarif
```

No dependencies on Midnight packages. Reads the `.zkir` JSON files that the compiler already produces. Works offline.

## What it finds

In ZK circuits, both branches of an `if/else` execute unconditionally — only the result is selected via `cond_select`. Constraints inside dead branches fire on invalid intermediate values, causing proof failures that JS testing can't catch.

compact-zkir-lint detects 11 patterns across three categories:

| Category | Rules | Severity |
|----------|-------|----------|
| **Divergence** (DIV-*) | [DIV-001](docs/rules/DIV-001.md) through [DIV-005](docs/rules/DIV-005.md) | error / warn |
| **Runtime** (RT-*) | [RT-001](docs/rules/RT-001.md) through [RT-004](docs/rules/RT-004.md) | warn / info |
| **Statistics** (STATS-*) | [STATS-001](docs/rules/STATS-001.md), [STATS-002](docs/rules/STATS-002.md) | info |

See the [full rules reference](docs/rules/README.md) for details, examples, and fix guidance.

## How it works

1. Parses compiled `.zkir` JSON files (v2 format, zero dependencies)
2. Builds a data-flow graph: which instruction produces which memory variable
3. Tracks guard propagation: which variables are inside conditional branches
4. Memoized zero-analysis: determines if dead-branch values default to zero (safe) vs non-zero (dangerous)
5. Flags constraint instructions operating on branch-local values before they reach a `cond_select` merge

## Documentation

- [Rules reference](docs/rules/README.md) — all 11 rules with examples and fix guidance
- [Branchless patterns](docs/guides/branchless-patterns.md) — how to restructure code to avoid divergence
- [CI integration](docs/guides/ci-integration.md) — SARIF output, GitHub Actions, exit codes
- [Differential testing](docs/guides/differential-testing.md) — JS vs ZKIR fuzz testing for deeper analysis
- [Compatibility](docs/compatibility.md) — version tracking and ZKIR v3 roadmap

## Acknowledgements

- [OpenZeppelin](https://github.com/OpenZeppelin) for the [Uint128.subU128 workaround](https://github.com/OpenZeppelin/midnight-apps/pull/309) that informed the [DIV-001](docs/rules/DIV-001.md) fix patterns
- The LunarSwap team for the [original bug report](https://github.com/LFDT-Minokawa/compact/issues/250) that led to this tool

## License

Apache-2.0
