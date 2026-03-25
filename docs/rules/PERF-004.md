# PERF-004: Hash operations dominate circuit

**Severity:** warn | **Since:** 0.2.0 | **Requires:** `--profile`

## What it detects

Circuits where hash operations contribute more than 80% of the estimated row count.

## Why it matters

Each Poseidon hash costs ~704 circuit rows. If hashes dominate the circuit, reducing the number of hash operations is the most effective way to reduce k and improve proving time.

## How to fix

- Batch data before hashing (one hash of N items vs N separate hashes)
- Cache hash results when the same inputs are hashed multiple times
- Consider whether all hashes are necessary for the circuit's security properties

## Related rules

- [PERF-001](PERF-001.md) — Impact of high k on WASM proving
