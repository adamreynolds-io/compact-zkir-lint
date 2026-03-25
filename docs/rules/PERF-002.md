# PERF-002: Circuit too large for WASM desktop

**Severity:** warn | **Since:** 0.2.0 | **Requires:** `--profile`

## What it detects

Circuits with k >= 18 (262,144+ rows), which are infeasible for WASM proving on desktop browsers.

## Why it matters

Desktop WASM proving is still single-threaded. At k >= 18, curve parameter files exceed 500MB, and proving takes several minutes. Users will need a Docker proof server or remote GPU service instead.

## Related rules

- [PERF-001](PERF-001.md) — WASM mobile limit (k >= 16)
- [PERF-003](PERF-003.md) — Docker/GPU threshold (k >= 20)
