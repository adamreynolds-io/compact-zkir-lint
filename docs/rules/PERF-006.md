# PERF-006: Circuit exceeds maximum k

**Severity:** error | **Since:** 0.2.0 | **Requires:** `--max-k` or config `maxK`

## What it detects

Circuits where the estimated (or exact) k value exceeds the user-defined maximum set via `--max-k` or the `maxK` field in `--profile-config`.

## Why it matters

Teams deploying to specific infrastructure need a hard ceiling on circuit size. A circuit that exceeds the target k cannot be proved in the target environment within acceptable time — or at all.

## How to configure

CLI:
```bash
npx compact-zkir-lint --max-k 14 -r contracts/src/artifacts/
```

Profile config (`--profile-config`):
```json
{
  "maxK": 14
}
```

## How to fix

See the [circuit profiling guide](../guides/circuit-profiling.md#reducing-circuit-size) for strategies to reduce circuit size.

## Related rules

- [PERF-001](PERF-001.md) through [PERF-003](PERF-003.md) — environment-specific k limits
