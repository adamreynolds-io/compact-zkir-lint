# Rules Reference

compact-zkir-lint detects patterns where ZK circuit constraints diverge from JavaScript execution. In ZK circuits, both branches of a conditional execute unconditionally — only the result is selected via `cond_select`. Constraint instructions that fire on dead-branch values cause proof failures invisible to JS testing.

## Severity Levels

| Level | Meaning |
|-------|---------|
| **error** | Will cause proof failure. Must fix before deploying. |
| **warn** | May cause proof failure depending on inputs. Should fix. |
| **info** | Code quality signal. Review for potential issues. |

## Divergence Rules (DIV-*)

Detect compiler-generated patterns where JS branching and ZK unconditional execution diverge. These correspond to known FIXMEs in the Compact compiler's ZKIR codegen ([compact#226](https://github.com/LFDT-Minokawa/compact/issues/226)).

| Rule | Severity | What it detects |
|------|----------|-----------------|
| [DIV-001](DIV-001.md) | error | `constrain_bits` on arithmetic in conditional branch |
| [DIV-002](DIV-002.md) | error | `reconstitute_field` in conditional branch |
| [DIV-003](DIV-003.md) | warn | `div_mod_power_of_two` in conditional branch |
| [DIV-004](DIV-004.md) | warn | `assert` on branch-local value |
| [DIV-005](DIV-005.md) | warn | `constrain_eq` in conditional branch |

## Runtime Rules (RT-*)

Detect patterns where `compact-runtime` (JS) and ZKIR preprocessing handle data differently, even outside conditional branches.

| Rule | Severity | What it detects |
|------|----------|-----------------|
| [RT-001](RT-001.md) | warn | `persistent_hash` with guarded inputs |
| [RT-002](RT-002.md) | info | `less_than` with guarded operands |
| [RT-003](RT-003.md) | info | `transient_hash` with guarded inputs |
| [RT-004](RT-004.md) | info | Deep arithmetic chain without intermediate constraints |

## Statistics Rules (STATS-*)

Report circuit complexity metrics that correlate with divergence risk.

| Rule | Severity | What it detects |
|------|----------|-----------------|
| [STATS-001](STATS-001.md) | info | Guard nesting depth >= 4 |
| [STATS-002](STATS-002.md) | info | Constraint density > 25% |

## Performance Rules (PERF-*)

Estimate proving time and flag circuits that are too large for specific proving environments. Requires `--profile` flag.

| Rule | Severity | What it detects |
|------|----------|-----------------|
| [PERF-001](PERF-001.md) | error | Circuit too large for WASM mobile (k >= 16) |
| [PERF-002](PERF-002.md) | warn | Circuit too large for WASM desktop (k >= 18) |
| [PERF-003](PERF-003.md) | info | Circuit needs GPU proving (k >= 20) |
| [PERF-004](PERF-004.md) | warn | Hash operations dominate circuit (> 80% of rows) |
| [PERF-005](PERF-005.md) | info | Lookup tables inflate circuit k |
| [PERF-006](PERF-006.md) | error | Circuit exceeds `--max-k` limit |

All thresholds and environment models are configurable via `.zkir-lint.json`. See the [circuit profiling guide](../guides/circuit-profiling.md) for configuration details.
