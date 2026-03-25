# PERF-001: Circuit too large for WASM mobile

**Severity:** error | **Since:** 0.2.0 | **Requires:** `--profile`

## What it detects

Circuits with k >= 16 (65,536+ rows), which are infeasible for single-threaded WASM proving on mobile devices.

## Why it matters

WASM in-browser proving on phones is single-threaded (Rayon `use_current_thread()`), memory-constrained (1-4 GB heap), and must load curve parameter files via async `getParams(k)`. At k >= 16, proving takes over 60 seconds on mobile — beyond acceptable UX thresholds.

## How to fix

See [circuit profiling guide](../guides/circuit-profiling.md) for strategies to reduce circuit size.

## Related rules

- [PERF-002](PERF-002.md) — WASM desktop limit (k >= 18)
- [PERF-004](PERF-004.md) — Hash operations dominating circuit size
