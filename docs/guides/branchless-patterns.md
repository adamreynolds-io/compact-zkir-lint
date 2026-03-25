# Branchless Patterns for Compact

The most common class of bugs detected by compact-zkir-lint ([DIV-001](../rules/DIV-001.md) through [DIV-005](../rules/DIV-005.md)) comes from constraints inside `if/else` branches. In ZK circuits, both branches execute unconditionally — only the result is selected via `cond_select`. Constraints fire on dead-branch values.

The fix is to restructure code so that constraints operate on values **after** the branch merge point.

## Pattern 1: Move the cast outside the branch

The simplest fix. Compute both branches, select, then cast.

```compact
// BEFORE (DIV-001): as Uint<N> inside branch
if (condition) {
    return (a + b) as Uint<64>;
} else {
    return c as Uint<64>;
}

// AFTER: cast on the selected value
const result = condition ? a + b : c;
return result as Uint<64>;
```

This works when both branches produce values that are in range after selection.

## Pattern 2: Branchless arithmetic

Replace the branch with arithmetic that computes the same result without branching.

```compact
// BEFORE (DIV-001): conditional borrow in subtraction
if (a.low >= b.low) {
    return U128 { low: a.low - b.low, high: highDiff };
} else {
    return U128 {
        low: (a.low + MODULUS() - b.low) as Uint<64>,
        high: highDiff - 1
    };
}

// AFTER: borrow flag replaces the branch
const borrow = a.low < b.low ? 1 : 0;
const lowDiff = a.low + borrow * MODULUS() - b.low;
const highDiff = a.high - b.high - borrow;
return U128 { low: lowDiff as Uint<64>, high: highDiff };
```

This is the pattern used in [OpenZeppelin's Uint128.subU128 fix](https://github.com/OpenZeppelin/midnight-apps/pull/309).

## Pattern 3: Guard the assertion

For [DIV-004](../rules/DIV-004.md) (assert inside branch), add the branch condition to the assertion itself.

```compact
// BEFORE (DIV-004): assert only valid when condition is true
if (condition) {
    assert(value > threshold, "Too low");
    // ...
}

// AFTER: assert is unconditionally safe
assert(!condition || value > threshold, "Too low");
```

## Pattern 4: Hoist conversions

For [DIV-002](../rules/DIV-002.md) and [DIV-003](../rules/DIV-003.md) (type conversions inside branches), move the conversion before the branch.

```compact
// BEFORE (DIV-002): bytes_to_field inside branch
if (should_convert) {
    stored = bytes_to_field(raw);
} else {
    stored = default_value;
}

// AFTER: convert first, select after
const converted = bytes_to_field(raw);
stored = should_convert ? converted : default_value;
```

## Pattern 5: Flatten nested conditionals

For [STATS-001](../rules/STATS-001.md) (deep nesting), combine conditions.

```compact
// BEFORE: 3 levels of nesting
if (a) {
    if (b) {
        if (c) {
            return x as Uint<64>;
        }
    }
}

// AFTER: single level
const all = a && b && c;
return all ? x as Uint<64> : default_value;
```

## When branchless patterns don't work

Some patterns can't be hoisted:

- **Side effects in branches**: ledger writes, event emissions. These must happen conditionally. Restructure to compute the value first, then write conditionally.
- **Early returns**: Compact doesn't have `return` inside expressions. Use ternary chains or intermediate variables.
- **Recursive structures**: If branches call different circuits, restructure to call both and select the result.

## Testing your fix

After restructuring, recompile and re-lint:

```bash
compact compile +0.30.0 src/MyContract.compact src/artifacts/MyContract
npx compact-zkir-lint src/artifacts/MyContract/zkir/myCircuit.zkir
```

For deeper validation, use [differential testing](differential-testing.md) to run the circuit through both JS and ZKIR and confirm they produce the same results.
