# STATS-002: High constraint density

**Severity:** info | **Since:** 0.1.0

## What it detects

Circuits where more than 25% of ZKIR instructions are constraint checks (`constrain_bits`, `constrain_eq`, `constrain_to_boolean`, `assert`).

## Why it matters

High constraint density may indicate:

- **Redundant bit constraints** from the compiler emitting `constrain_bits` for each intermediate cast
- **Over-constraining** from defensive coding patterns that add unnecessary assertions
- **Compiler inefficiency** where the same value is constrained multiple times through different code paths

Each constraint adds to proof generation time and increases the surface area for divergence bugs.

## Examples

### Over-constrained code (flagged)

```compact
pragma language_version >= 0.22.0;

export pure circuit over_constrained(a: Uint<64>, b: Uint<64>): Uint<64> {
  const sum = (a + b) as Uint<64>;       // constrain_bits
  const checked = sum as Uint<64>;        // redundant constrain_bits
  assert(checked < 1000000);              // assert
  const result = checked as Uint<64>;     // redundant constrain_bits
  return result;
}
```

### Fixed: remove redundant constraints

```compact
pragma language_version >= 0.22.0;

export pure circuit minimal_constraints(a: Uint<64>, b: Uint<64>): Uint<64> {
  const sum = (a + b) as Uint<64>;  // single constrain_bits — sufficient
  assert(sum < 1000000);
  return sum;
}
```

## Notes

This rule reports at the circuit level, not per-instruction. The threshold (25%) is calibrated against typical Compact compiler output — most circuits have 10-20% constraint density. Circuits above 25% are worth reviewing but may not indicate a bug.

## Related rules

- [STATS-001](STATS-001.md) — Deep nesting often correlates with high constraint density
