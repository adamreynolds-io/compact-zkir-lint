# Proof Server Benchmark Tool

Measures real proving time by sending pre-recorded binary payloads to a Midnight proof server. Produces a profile config file with measured timings for k=10-16 and extrapolated estimates to k=25.

## Quick Start

```bash
# 1. Start a proof server with SRS curve files mounted
docker run -d -p 6300:6300 \
  -v $HOME/.cache/midnight/zk-params:/root/.cache/midnight/zk-params \
  ghcr.io/midnight-ntwrk/proof-server:8.0.3

# 2. Setup (first time only — requires Compact compiler)
npm run benchmark:setup

# 3. Run benchmarks
npm run benchmark -- -o bench/profile.json

# 4. Use the profile with the linter
npm run build
npx zkir-lint --profile --profile-config bench/profile.json circuit.zkir
```

## How It Works

1. **Capture fixtures** — compile a Compact contract with circuits at target k values, execute through compact-js, serialize the proof preimage + key material into binary payloads
2. **Benchmark** — send each payload to `POST /prove`, measure wall-clock time. Automatically warms up the server and verifies k=10 proves before starting
3. **Extrapolate** — proving time roughly doubles per k. Measured results (k=10-16) are extended to k=25
4. **Output** — profile config file compatible with `--profile-config`, plus a visual summary table

## Benchmark CLI

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
  -f, --format env|full          env = profile config for --profile-config; full = detailed (default: env)
  -h, --help                     Show help
```

## Output

The benchmark prints a summary table to the console:

```
  k       rows  tblRows  hashes  instrs  payload    proving time  distribution
  ----------------------------------------------------------------------------------------
  k = ceil(log2(max(rows, tableRows, instances) + 6))

   10      719        0       0      15     15KB     0.17s [0.17s-0.18s]    ░░░░░░░░░░░░░░░░░░░░
   11     1454        2       1      29    2.7MB     0.60s [0.60s-0.61s]    ██░░░░░░░░░░░░░░░░░░
   12     2158        2       2      30    5.0MB     0.78s [0.78s-0.78s]    ██░░░░░░░░░░░░░░░░░░
   ...
   16    33134        2      46      74   73.0MB      7.7s [7.7s-7.7s]      ████████████████████
   17    66222        2      93     121  145.6MB    FAILED (payload too large for proof server)

  Extrapolated (doubling per k):
   17     14.2s (SRS: 24MB)
   18     26.3s (SRS: 48MB)
   ...
   25    31m47s (SRS: 6GB)
```

With `-o`, the profile JSON is written to the specified file (no JSON on console).

## Fixture Format

Binary `.bin` files named `k{N}-{source}-{circuit}.bin` with `.meta.json` sidecars:

```
bench/fixtures/
  k10-benchmark-bench_k10.bin
  k10-benchmark-bench_k10.meta.json
  k16-benchmark-bench_k16.bin
  k16-benchmark-bench_k16.meta.json
```

Each `.bin` contains a serialized `(ProofPreimageVersioned, Option<ProvingKeyMaterial>, Option<Fr>)` — the same format `createProvingPayload()` from `@midnight-ntwrk/ledger-v8` produces. The payload includes the proof preimage, prover key, verifier key, and binary ZKIR.

Metadata sidecar includes circuit stats for the summary table:

```json
{
  "k": 12,
  "circuit": "bench_k12",
  "contract": "benchmark",
  "rows": 2158,
  "tableRows": 2,
  "hashes": 2,
  "instructions": 30,
  "payloadBytes": 5209327,
  "sdkVersion": "8.0.3",
  "recordedAt": "2026-03-25T15:12:59Z"
}
```

## Generating Fixtures

The benchmark contract (`bench/contracts/benchmark.compact`) is auto-generated with circuits at target k values. Each circuit calls `persistentHash` N times to produce the target row count.

```bash
# 1. Generate the Compact source (edit generate-contract.ts to change k range)
npx tsx bench/generate-contract.ts

# 2. Compile
compact compile bench/contracts/benchmark.compact bench/benchmark-compiled

# 3. Capture proof payloads
npx tsx bench/capture-benchmark.ts
```

### Payload size limits

The proof server's HTTP body limit restricts payload size. Since each payload bundles the prover key (which doubles per k), circuits above k=16 produce payloads >100MB that crash the proof server:

| k  | Prover key | Payload |
|----|-----------|---------|
| 14 | 19MB      | 19MB    |
| 15 | 37MB      | 37MB    |
| 16 | 73MB      | 73MB    |
| 17 | 146MB     | 146MB   |
| 18 | 291MB     | 291MB   |

k=10-16 are directly measured. k=17-25 are extrapolated from the observed doubling rate.

### SRS curve files

The proof server needs SRS parameter files (`bls_midnight_2p{k}`) for each k value it proves. These are downloaded from S3 on demand, but this can fail in Docker. Mount your local cache to avoid downloads:

```bash
docker run -d -p 6300:6300 \
  -v $HOME/.cache/midnight/zk-params:/root/.cache/midnight/zk-params \
  ghcr.io/midnight-ntwrk/proof-server:8.0.3
```

SRS files are at `~/.cache/midnight/zk-params/bls_midnight_2p{k}`. Sizes double per k: 12MB (k=16), 192MB (k=20), 6GB (k=25).

## SDK Packages

Installed as devDependencies for fixture generation:

- `@midnight-ntwrk/compact-js` — contract execution via Effect runtime
- `@midnight-ntwrk/compact-runtime` — circuit context, constructor context
- `@midnight-ntwrk/midnight-js-contracts` — `createUnprovenCallTxFromInitialStates`
- `@midnight-ntwrk/midnight-js-types` — `ZKConfigProvider`, key/ZKIR constructors
- `@midnight-ntwrk/midnight-js-network-id` — `setNetworkId`
- `@midnight-ntwrk/midnight-js-utils` — `parseCoinPublicKeyToHex`
- `@midnight-ntwrk/ledger-v8` — `proofDataIntoSerializedPreimage`, `createProvingPayload`

Regenerate fixtures after SDK version upgrades — the binary serialization format may change.
