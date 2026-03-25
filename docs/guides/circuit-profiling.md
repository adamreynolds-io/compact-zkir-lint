# Circuit Performance Profiling

compact-zkir-lint can estimate how long your circuits will take to prove across different environments. This helps you decide whether to target in-browser WASM proving, a Docker proof server, or a remote GPU service.

## Quick start

```bash
# Profile all circuits
npx compact-zkir-lint --profile -r contracts/src/artifacts/

# Enforce a maximum k value
npx compact-zkir-lint --profile --max-k 14 -r contracts/src/artifacts/

# Profile for a specific target
npx compact-zkir-lint --profile --target wasm-mobile *.zkir
```

## Understanding k

The **k value** (log2 of circuit rows) is the primary metric for proving performance. A circuit with k=15 has 2^15 = 32,768 rows. Proving time grows roughly exponentially with k.

The linter estimates k by mapping ZKIR instructions to circuit row costs using data from the Midnight proving system's golden files. Hash operations (Poseidon, 704 rows each) typically dominate.

For exact k values, install `@midnight-ntwrk/zkir-v2` and use `--k-source wasm`.

## Proving environments

Four built-in environments are provided. All are configurable via `.zkir-lint.json`.

| Environment | Threading | k limit | Use case |
|-------------|-----------|---------|----------|
| **wasm-mobile** | Single-threaded | 15 | Phone browsers, constrained devices |
| **wasm-desktop** | Single-threaded | 17 | Desktop browsers, Node.js |
| **docker** | Multi-threaded (CPU) | 22 | Self-hosted proof server |
| **gpu** | GPU-accelerated | 25 | Remote proving service |

### WASM limitations

WASM proving (in-browser or Node.js) has specific constraints:
- **Single-threaded**: Rayon parallelism disabled (`use_current_thread()`)
- **Memory**: Browser WASM heaps are 1-4 GB max
- **Curve parameters**: Must load `bls_midnight_2p{k}` files via `getParams(k)` — these are ~500MB+ for k >= 18
- **No extra curve files**: WASM cannot load additional curve parameters beyond what's bundled

## Estimated proving times

| k | Rows | WASM mobile | WASM desktop | Docker (8-core) | GPU service |
|---|------|-------------|--------------|-----------------|-------------|
| 10 | 1K | 1-3s | <1s | <1s | <1s |
| 12 | 4K | 5-15s | 2-5s | <1s-2s | <1s-2s |
| 13 | 8K | 15-40s | 8-20s | 2-5s | <1s-2s |
| 14 | 16K | 40-90s | 8-20s | 2-5s | <1s-2s |
| 15 | 32K | 90-240s | 20-50s | 5-15s | 2-5s |
| 16 | 65K | infeasible | 50-120s | 5-15s | 2-5s |
| 17 | 131K | infeasible | 120-300s | 30-60s | 8-20s |
| 18 | 262K | infeasible | infeasible | 30-60s | 8-20s |
| 20 | 1M | infeasible | infeasible | 60-180s | 30-60s |
| 22 | 4M | infeasible | infeasible | 300-600s | 60-180s |
| 25 | 33M | infeasible | infeasible | infeasible | 600-1200s |

These are rough estimates. Actual times depend on hardware, column count, and lookup density. All values are configurable via `.zkir-lint.json`.

## Setting a maximum k

Use `--max-k` to enforce a ceiling. Any circuit exceeding it produces a PERF-006 error:

```bash
npx compact-zkir-lint --max-k 14 -r contracts/src/artifacts/
```

This implicitly enables profiling. Set it in your config for CI:

```json
{
  "maxK": 14,
  "profile": true
}
```

## Configuration

All profiling parameters live in `.zkir-lint.json` (searched in CWD and parent directories). CLI flags override config values.

### Full example

```json
{
  "maxK": 14,
  "profile": true,
  "severity": "warn",
  "targets": ["wasm-mobile", "docker"],
  "environments": {
    "wasm-mobile": {
      "label": "Low-end Android",
      "maxK": 13,
      "warnK": 11,
      "timings": [[10, 3, 10], [12, 15, 45], [13, 45, 120]]
    },
    "wasm-desktop": null,
    "my-beefy-server": {
      "label": "Dedicated 32-core",
      "maxK": 24,
      "warnK": 22,
      "timings": [[14, 0.5, 1], [18, 3, 8], [22, 30, 90], [24, 180, 400]]
    }
  },
  "rowCosts": {
    "persistent_hash": { "rows": 800, "tableRows": 2 }
  }
}
```

### Config fields

| Field | Type | Description |
|-------|------|-------------|
| `maxK` | number | Maximum acceptable k. PERF-006 error if exceeded. |
| `profile` | boolean | Enable profiling by default (same as `--profile`). |
| `targets` | string[] | Which environments to evaluate. Keys into `environments`. |
| `severity` | string | Minimum severity: `"error"`, `"warn"`, or `"info"`. |
| `environments` | object | Override or add proving environments (see below). Set to `null` to remove a built-in. |
| `rowCosts` | object | Override instruction-to-row cost mapping. Merged with built-in defaults. |

### Custom environments

Each environment has:

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Display name in output. |
| `maxK` | number | k values above this are infeasible. |
| `warnK` | number | k values above this are flagged as slow. |
| `timings` | array | Sorted list of `[maxK, lowSeconds, highSeconds]`. For a given k, the first entry where `k <= maxK` is used. |

The `timings` array maps k values to estimated proving time ranges. Example:

```json
"timings": [[10, 1, 3], [12, 5, 15], [14, 30, 90]]
```

This means: k <= 10 takes 1-3s, k <= 12 takes 5-15s, k <= 14 takes 30-90s, k > 14 is infeasible.

### Row cost overrides

Override how ZKIR instructions map to circuit rows. Merged with built-in defaults from Midnight's golden files.

```json
"rowCosts": {
  "persistent_hash": { "rows": 800, "tableRows": 2 },
  "my_custom_op": { "rows": 1000, "tableRows": 500 }
}
```

Built-in defaults: `persistent_hash` and `transient_hash` = 704 rows (Poseidon), `ec_mul` = 500, arithmetic ops = 1.

## Reducing circuit size

If your circuit is too large for your target environment:

1. **Reduce hash operations**: Each Poseidon hash costs ~704 rows. Batch data before hashing.
2. **Flatten conditionals**: Deep nesting ([STATS-001](../rules/STATS-001.md)) multiplies row count.
3. **Simplify arithmetic**: Long chains ([RT-004](../rules/RT-004.md)) add rows without adding value.
4. **Split circuits**: Break large operations into multiple smaller circuits.

## Profiling rules

| Rule | Severity | Condition |
|------|----------|-----------|
| [PERF-001](../rules/PERF-001.md) | error | k >= 16 (infeasible for WASM mobile) |
| [PERF-002](../rules/PERF-002.md) | warn | k >= 18 (infeasible for WASM desktop) |
| [PERF-003](../rules/PERF-003.md) | info | k >= 20 (slow on Docker, needs GPU) |
| [PERF-004](../rules/PERF-004.md) | warn | Hash ops > 80% of circuit rows |
| [PERF-005](../rules/PERF-005.md) | info | Lookup tables inflate k |
| [PERF-006](../rules/PERF-006.md) | error | Circuit exceeds `--max-k` limit |
