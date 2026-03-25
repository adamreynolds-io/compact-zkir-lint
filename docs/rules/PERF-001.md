# PERF-001: Circuit exceeds WASM prover limit

**Severity:** warn | **Since:** 0.2.0 | **Always-on** (does not require `--profile`)

## What it detects

Circuits with k > 15 (32,768+ rows), which cannot be proved by WASM in-browser provers.

## Why it matters

WASM provers (mobile and desktop browsers) have a hard limit of k=15. Circuits above this require a proof server with:
- The SRS curve file for that k value (`bls_midnight_2p{k}`, 12MB at k=16, doubling per k up to 6GB at k=25)
- Sufficient memory and CPU for proving

This warning fires without `--profile` because it represents a hard infrastructure constraint, not a performance preference.

## How to fix

See [circuit profiling guide](../guides/circuit-profiling.md) for strategies to reduce circuit size.

## Related rules

- [PERF-002](PERF-002.md) — WASM desktop limit (k >= 18, requires --profile)
- [PERF-004](PERF-004.md) — Hash operations dominating circuit size
