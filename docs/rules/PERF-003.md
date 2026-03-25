# PERF-003: Circuit needs GPU proving

**Severity:** info | **Since:** 0.2.0 | **Requires:** `--profile`

## What it detects

Circuits with k >= 20 (1,048,576+ rows), which are slow on CPU-based Docker proof servers and benefit from GPU acceleration.

## Why it matters

At k >= 20, CPU proving takes 60+ seconds even with 8 cores. Remote GPU proving services handle this in 30-180 seconds but add network latency and operational complexity.

## Related rules

- [PERF-002](PERF-002.md) — WASM desktop limit (k >= 18)
