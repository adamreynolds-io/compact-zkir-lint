# PERF-005: Lookup tables inflate circuit k

**Severity:** info | **Since:** 0.2.0 | **Requires:** `--profile`

## What it detects

Circuits with large lookup tables that force a higher k value regardless of instruction count.

## Why it matters

PLONK circuits require 2^k rows to accommodate both computation rows and lookup table rows. If a hash gadget requires 65,536 table rows (e.g., Blake2b), the circuit is forced to k >= 17 even if the computation only needs k = 12.

In Midnight's current ZKIR, `persistent_hash` and `transient_hash` use Poseidon (2 table rows), so this rule rarely triggers. It becomes relevant if future compiler versions add different hash algorithms or complex lookup-based gadgets.

## Related rules

- [PERF-004](PERF-004.md) — Hash operations dominating row count
