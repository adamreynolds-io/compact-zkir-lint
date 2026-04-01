# Circuit Performance Profiling

compact-zkir-lint estimates how long your circuits will take to prove across different environments. Circuits with k > 15 always produce a warning since they cannot be proved in WASM browsers.

## Quick start

```bash
# Profile all circuits with built-in timing estimates
npx compact-zkir-lint --profile -r contracts/src/artifacts/

# Profile with real benchmark data from your proof server
npx compact-zkir-lint --profile --profile-config profile.json -r contracts/src/artifacts/

# Enforce a maximum k value
npx compact-zkir-lint --profile --max-k 14 -r contracts/src/artifacts/

# Profile for a specific target
npx compact-zkir-lint --profile --target wasm-mobile *.zkir
```

## Understanding k

The **k value** (log2 of circuit rows) is the primary metric for proving performance. A circuit with k=15 has 2^15 = 32,768 rows. Proving time roughly doubles per k increment.

```
k = ceil(log2(max(rows, tableRows, instances) + 6))
```

The linter estimates k by mapping ZKIR instructions to circuit row costs using data from the Midnight proving system's golden files. Hash operations (Poseidon, 704 rows each) typically dominate.

For exact k values, install `@midnight-ntwrk/zkir-v2` and use `--k-source wasm`.

## WASM hard limit (always-on)

PERF-001 fires for any circuit with k > 15, even without `--profile`. WASM provers (mobile and desktop browsers) cannot handle circuits above this limit. The warning includes the SRS curve file size required for proof servers.

## Proving environments

Four built-in environments are provided:

| Environment | Threading | k limit | Use case |
|-------------|-----------|---------|----------|
| **wasm-mobile** | Single-threaded | 15 | Phone browsers, constrained devices |
| **wasm-desktop** | Single-threaded | 17 | Desktop browsers, Node.js |
| **docker** | Multi-threaded (CPU) | 22 | Self-hosted proof server |
| **gpu** | GPU-accelerated | 25 | Remote proving service |

## Benchmarking your proof server

The built-in timing estimates are rough. For accurate data from your hardware, use the benchmark tool:

```bash
# 1. Start a proof server with SRS curve files mounted
docker run -d -p 6300:6300 \
  -v $HOME/.cache/midnight/zk-params:/root/.cache/midnight/zk-params \
  ghcr.io/midnight-ntwrk/proof-server:8.0.3

# 2. Setup (first time only — requires Compact compiler)
npm run benchmark:setup

# 3. Run benchmarks and generate a profile config
npm run benchmark -- -o profile.json

# 4. Use the profile with the linter
npx compact-zkir-lint --profile --profile-config profile.json circuit.zkir
```

### Benchmark output

The benchmark prints a summary table showing circuit stats and measured proving times:

```
  k       rows  tblRows  hashes  instrs  payload    proving time  distribution
  ----------------------------------------------------------------------------------------
   10      719        0       0      15     15KB     0.17s [0.17s-0.18s]    ░░░░░░░░░░░░░░░░░░░░
   11     1454        2       1      29    2.7MB     0.60s [0.60s-0.61s]    ██░░░░░░░░░░░░░░░░░░
   12     2158        2       2      30    5.0MB     0.78s [0.78s-0.78s]    ██░░░░░░░░░░░░░░░░░░
   ...
   16    33134        2      46      74   73.0MB      7.7s [7.7s-7.7s]      ████████████████████

  Extrapolated (doubling per k):
   17     14.2s (SRS: 24MB)
   18     26.3s (SRS: 48MB)
   ...
   25    31m47s (SRS: 6GB)
```

### Measured vs extrapolated values

k=10-16 are directly measured against the proof server. k=17-25 are extrapolated from the observed doubling rate because payload size limits prevent direct measurement at higher k values.

Each benchmark payload bundles the prover key, which doubles per k:

| k  | Prover key | Payload size |
|----|-----------|--------------|
| 14 | 19MB      | 19MB         |
| 15 | 37MB      | 37MB         |
| 16 | 73MB      | 73MB         |
| 17 | 146MB     | 146MB        |
| 18 | 291MB     | 291MB        |

Above k=16, payloads exceed the proof server's HTTP body limit (~100MB), so the benchmark extrapolates from the measured doubling rate instead.

### Benchmark CLI options

```
npm run benchmark -- [options]

Options:
  --server-url, --server <url>   Proof server URL (default: http://localhost:6300)
  -n, --iterations <n>           Iterations per fixture (default: 3)
  --timeout <ms>                 Per-request timeout in ms (default: 600000)
  --fixture-dir, --fixtures <p>  Directory with .bin fixtures (default: bench/fixtures)
  --target-k <k,...>             Only benchmark specific k values
  --label <name>                 Environment label (default: "benchmarked")
  --warn-threshold <s>           Seconds threshold for warnK (default: 60)
  -o, --output <path>            Write profile JSON to file
  -f, --format env|full          env = profile config; full = detailed (default: env)
```

See [bench/README.md](../../bench/README.md) for fixture generation and format details.

## Setting a maximum k

Use `--max-k` to enforce a ceiling. Any circuit exceeding it produces a PERF-006 error:

```bash
npx compact-zkir-lint --max-k 14 -r contracts/src/artifacts/
```

This implicitly enables profiling.

## Profile configuration

Use `--profile-config <path>` to load custom environments and timing data from a JSON file. The benchmark tool generates this file automatically.

### Example profile config

```json
{
  "maxK": 14,
  "profile": true,
  "targets": ["wasm-mobile", "my-server"],
  "environments": {
    "wasm-desktop": null,
    "my-server": {
      "label": "Docker proof-server 8.0.3",
      "maxK": 25,
      "warnK": 19,
      "timings": [
        [10, 0.17, 0.18],
        [12, 0.78, 0.78],
        [14, 2.44, 2.45],
        [16, 7.72, 7.74],
        [20, 89.37, 89.58],
        [25, 1907.08, 1911.55]
      ]
    }
  }
}
```

### Config fields

| Field | Type | Description |
|-------|------|-------------|
| `maxK` | number | Maximum acceptable k. PERF-006 error if exceeded. |
| `profile` | boolean | Enable profiling by default (same as `--profile`). |
| `targets` | string[] | Which environments to evaluate. |
| `severity` | string | Minimum severity: `"error"`, `"warn"`, or `"info"`. |
| `environments` | object | Override or add proving environments. Set to `null` to remove a built-in. |
| `rowCosts` | object | Override instruction-to-row cost mapping. |

### Custom environments

Each environment has:

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Display name in output. |
| `maxK` | number | k values above this are infeasible. |
| `warnK` | number | k values above this are flagged as slow. |
| `timings` | array | Sorted `[maxK, lowSeconds, highSeconds]` entries. First entry where `k <= maxK` is used. |

## SRS curve files

Proof servers need SRS parameter files (`bls_midnight_2p{k}`) for each k value. These double per k:

| k | SRS file size |
|---|--------------|
| 10 | 192KB |
| 15 | 6MB |
| 16 | 12MB |
| 18 | 48MB |
| 20 | 192MB |
| 22 | 768MB |
| 25 | 6GB |

SRS files are stored at `~/.cache/midnight/zk-params/`. Mount this directory when running a proof server in Docker to avoid re-downloading:

```bash
docker run -d -p 6300:6300 \
  -v $HOME/.cache/midnight/zk-params:/root/.cache/midnight/zk-params \
  ghcr.io/midnight-ntwrk/proof-server:8.0.3
```

## Reducing circuit size

If your circuit is too large for your target environment:

1. **Reduce hash operations**: Each Poseidon hash costs ~704 rows. Batch data before hashing.
2. **Flatten conditionals**: Deep nesting ([STATS-001](../rules/STATS-001.md)) multiplies row count.
3. **Simplify arithmetic**: Long chains ([RT-004](../rules/RT-004.md)) add rows without adding value.
4. **Split circuits**: Break large operations into multiple smaller circuits.

## Profiling rules

| Rule | Severity | Condition | Requires --profile |
|------|----------|-----------|--------------------|
| [PERF-001](../rules/PERF-001.md) | warn | k > 15 (WASM hard limit) | No (always-on) |
| [PERF-003](../rules/PERF-003.md) | info | k >= 20 (slow on Docker, needs GPU) | Yes |
| [PERF-004](../rules/PERF-004.md) | warn | Hash ops > 80% of circuit rows | Yes |
| [PERF-005](../rules/PERF-005.md) | info | Lookup tables inflate k | Yes |
| [PERF-006](../rules/PERF-006.md) | error | Circuit exceeds `--max-k` limit | Yes |
