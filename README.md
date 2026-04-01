# compact-zkir-lint

**Your Compact circuit compiled fine. Your tests pass. But the proof server rejects your transaction.**

`compact-zkir-lint` tells you why before your users do.

```bash
npx compact-zkir-lint -r contracts/src/artifacts/
```

```
  addLiquidity (v2, k=13): 1 error(s)
    instructions: 343  inputs: 5  constrain_bits: 12  cond_select: 8
    guarded regions: 3 (max depth 2)  proof payload: ~384KB
    ERROR [DIV-001] inst 128: constrain_bits(bits=64) on arithmetic in conditional branch (guard=824)

1 error(s) | 4/11 circuits affected
```

## Install and run

```bash
# Scan a single circuit
npx compact-zkir-lint circuit.zkir

# Scan all circuits in your compiled artifacts
npx compact-zkir-lint -r contracts/src/artifacts/

# Profile proving time across environments
npx compact-zkir-lint --profile -r contracts/src/artifacts/

# CI-friendly: SARIF output, non-zero exit on errors
npx compact-zkir-lint -r contracts/src/artifacts/ --format sarif > results.sarif
```

No dependencies on Midnight packages. Reads the `.zkir` JSON files that the compiler already produces. Works offline.

## Benchmark your proof server

Built-in timing estimates are rough. Measure real proving times on your hardware:

```bash
# Start a proof server
docker run -d -p 6300:6300 \
  -v $HOME/.cache/midnight/zk-params:/root/.cache/midnight/zk-params \
  ghcr.io/midnight-ntwrk/proof-server:8.0.3

# Generate fixtures and run benchmarks (first time: npm run benchmark:setup)
npm run benchmark -- -o profile.json

# Lint with real timing data
npx compact-zkir-lint --profile --profile-config profile.json -r contracts/src/artifacts/
```

Measures k=10-16 directly against the proof server, extrapolates k=17-25 from the observed doubling rate. See the [circuit profiling guide](docs/guides/circuit-profiling.md) for output format, payload size limits, and configuration.

## What it finds

In ZK circuits, both branches of an `if/else` execute unconditionally — only the result is selected via `cond_select`. Constraints inside dead branches fire on invalid intermediate values, causing proof failures that JS testing can't catch.

compact-zkir-lint detects 16 patterns across four categories:

| Category | Rules | Severity |
|----------|-------|----------|
| **Divergence** (DIV-*) | [DIV-001](docs/rules/DIV-001.md) through [DIV-005](docs/rules/DIV-005.md) | error / warn |
| **Runtime** (RT-*) | [RT-001](docs/rules/RT-001.md) through [RT-004](docs/rules/RT-004.md) | warn / info |
| **Statistics** (STATS-*) | [STATS-001](docs/rules/STATS-001.md), [STATS-002](docs/rules/STATS-002.md) | info |
| **Performance** (PERF-*) | [PERF-001](docs/rules/PERF-001.md) through [PERF-006](docs/rules/PERF-006.md) | error / warn / info |

See the [full rules reference](docs/rules/README.md) for details, examples, and fix guidance.

## How it works

1. Parses compiled `.zkir` JSON files (v2 format, zero dependencies)
2. Builds a data-flow graph: which instruction produces which memory variable
3. Tracks guard propagation: which variables are inside conditional branches
4. Memoized zero-analysis: determines if dead-branch values default to zero (safe) vs non-zero (dangerous)
5. Flags constraint instructions operating on branch-local values before they reach a `cond_select` merge

## Documentation

- [Rules reference](docs/rules/README.md) — all 17 rules with examples and fix guidance
- [Circuit profiling](docs/guides/circuit-profiling.md) — estimate proving time, benchmark your proof server, payload sizes
- [Branchless patterns](docs/guides/branchless-patterns.md) — how to restructure code to avoid divergence
- [CI integration](docs/guides/ci-integration.md) — SARIF output, GitHub Actions, exit codes, profiling in CI
- [Differential testing](docs/guides/differential-testing.md) — JS vs ZKIR fuzz testing for deeper analysis
- [Compatibility](docs/compatibility.md) — version tracking and ZKIR v3 roadmap
- [Benchmark tool](bench/README.md) — fixture generation, binary format, SDK packages

## Acknowledgements

- [OpenZeppelin](https://github.com/OpenZeppelin) for the [Uint128.subU128 workaround](https://github.com/OpenZeppelin/midnight-apps/pull/309) that informed the [DIV-001](docs/rules/DIV-001.md) fix patterns
- The LunarSwap team for the [original bug report](https://github.com/LFDT-Minokawa/compact/issues/250) that led to this tool

## License

Apache-2.0
