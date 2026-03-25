# STATS-001: Deep guard nesting

**Severity:** info | **Since:** 0.1.0

## What it detects

Guard variables (branch conditions) with nesting depth >= 4. This means at least 4 levels of nested `if/else` in the original Compact source.

## Why it matters

Each level of conditional nesting multiplies the risk of divergence bugs. A guard at depth 4 means the variable is inside 4 nested branches, each of which executes unconditionally in ZK. The combinatorial explosion of dead-branch states makes it harder to reason about constraint safety and increases the chance that an intermediate value violates a constraint.

Deep nesting also increases circuit complexity and proof generation time.

## Examples

### Deep nesting (flagged)

```compact
pragma language_version >= 0.22.0;

export circuit deeply_nested(
  a: Boolean, b: Boolean, c: Boolean, d: Boolean,
  val: Uint<64>
): Uint<64> {
  if (a) {
    if (b) {
      if (c) {
        if (d) {
          return val * 2 as Uint<64>;  // depth 4: high divergence risk
        }
        return val;
      }
      return val;
    }
    return val;
  }
  return 0;
}
```

### Fixed: flatten with early returns or branchless logic

```compact
pragma language_version >= 0.22.0;

export circuit flattened(
  a: Boolean, b: Boolean, c: Boolean, d: Boolean,
  val: Uint<64>
): Uint<64> {
  const all_true = a && b && c && d;
  const multiplier = all_true ? 2 : 1;
  const should_return_val = a;  // simplified; actual logic depends on intent
  return should_return_val ? (val * multiplier) as Uint<64> : 0;
}
```

## Related rules

- [STATS-002](STATS-002.md) — High constraint density, often correlated with deep nesting
- [DIV-001](DIV-001.md) — Constraint failures more likely with deeper nesting
