# compact-zkir-lint — Maintenance Guide

This file instructs Claude Code how to update this linter when new Compact compiler versions ship.

## What this tool does

Static analyzer for compiled Compact `.zkir` files. Detects patterns where `compact-runtime` (JS) succeeds but ZKIR proof validation fails — divergence bugs caused by the compiler emitting unconditional constraints inside conditional branches.

## When to update

Run this process when:
- A new Compact compiler version ships (0.31.0, 0.32.0, etc.)
- A new ZKIR format version is introduced (v3 backend, tracked in compact#86)
- The compiler team claims to have fixed compact#226 (downcasts conditional in ZKIR)
- New divergence patterns are reported by the community

## Update process

### Step 1: Recompile contracts with the new compiler version

```bash
cd /Users/adam/Work/midnight-apps/contracts
compact compile +NEW_VERSION --skip-zk src/lunarswap/Lunarswap.compact src/artifacts/lunarswap/Lunarswap
```

Also recompile any other contracts under test. Check the midnight-apps, midnight-contracts, and compact example repos for `.compact` source files.

### Step 2: Run the linter against all available ZKIR files

```bash
cd /Users/adam/Work/zkir-lint
npx tsx src/cli.ts -r /Users/adam/Work --severity info -q
```

This scans all `.zkir` files across all repos under `/Users/adam/Work/`. Compare the output against the previous version's results. Look for:
- New errors (patterns the new compiler introduced)
- Resolved errors (patterns the compiler fixed)
- Changed error counts per circuit

### Step 3: Check if the compiler FIXMEs are resolved

The compiler source at `/Users/adam/Work/compactc/compiler/passes.ss` contains these FIXMEs that directly cause the bugs we detect:

```
passes.ss:9350  FIXME: zkir field->bytes #f needs to respect test     → DIV-003
passes.ss:9655  FIXME: are all of these okay if inputs are undefined? → DIV-004
passes.ss:9671  FIXME: zkir bytes->field needs to respect test        → DIV-002
passes.ss:9676  FIXME: zkir downcast-unsigned with safe? = #f ...     → DIV-001
```

Search for these FIXMEs in the new compiler version:
```bash
grep -n "FIXME.*respect test\|FIXME.*undefined" /Users/adam/Work/compactc/compiler/passes.ss
```

If a FIXME is removed, the corresponding rule may produce false positives on new compiler output. Test and update the rule.

### Step 4: Run differential fuzz tests

If the midnight-apps contracts are updated for the new compiler version:

```bash
cd /Users/adam/Work/midnight-apps/contracts
npx vitest run src/lunarswap/tests/fuzz-divergence.test.ts
```

This runs circuits through JS then validates against ZKIR preprocessing. If tests that previously failed now pass, the compiler fix is working. If new tests fail, there are new divergence patterns.

### Step 5: Check for ZKIR v3 format changes

If the new compiler ships ZKIR v3 output (compact#86), the linter needs v3 parsing support:

1. Check the ZKIR version: `head -3 compiled-circuit.zkir`
2. If `"major": 3`: the linter's `ir.ts` needs updating
   - v3 uses named identifiers (`%v_0`) instead of numeric indices
   - v3 has typed inputs (`{ "name": "%v_0", "type": "Scalar<BLS12-381>" }`)
   - The instruction set is similar but field names differ (e.g., `val` instead of `var` in constrain_bits)
3. Reference: `/Users/adam/Work/midnight-ledger/zkir-v3/src/ir.rs` for the v3 instruction enum

### Step 6: Update version tracking in README

Update the compatibility table and version tracking section in README.md with the new compiler version's status (affected/fixed/partially fixed).

### Step 7: Update rules if needed

If the new compiler changes how it lowers `if/else` to ZKIR:
- Add/update rules in `src/rules.ts`
- Each rule is a function `(graph: IrGraph) => Finding[]`
- The `IrGraph` is built by `src/ir.ts` from parsed ZKIR JSON
- Test with `npx tsx src/cli.ts path/to/new-compiler-output.zkir`

### Step 8: Run the Rust ZKIR boundary tests

```bash
cd /Users/adam/Work/midnight-ledger
MIDNIGHT_PP=transient-crypto/static cargo test -p midnight-zkir --test proofs
```

These tests exercise `constrain_bits` boundaries at the ZKIR preprocessing level. They should pass regardless of compiler version — they test the proof server's constraint validation logic, not the compiler output.

## Architecture

```
src/
  cli.ts          CLI entry point
  analyze.ts      Loads ZKIR → runs rules → produces CircuitReport
  ir.ts           Builds IrGraph from ZKIR instructions:
                    - instToVar: instruction index → memory variable
                    - varGuard: variable → branch guard
                    - condSelectOutputs: variables that are branch merge points
                    - buildZeroAnalysis(): memoized dead-branch value analysis
  rules.ts        11 detection rules (DIV-001..005, RT-001..004, STATS-001..002)
  fuzz.ts         ZKIR-guided input generation for differential testing
  diff.ts         JS vs ZKIR comparison engine
  harness.ts      Dependency-injected test harness (consumer provides Midnight packages)
  format.ts       Text/JSON/SARIF output
  types.ts        Type definitions
```

## Key repos and files

| Repo | Path | What |
|------|------|------|
| compactc | `compiler/passes.ss` | Compact compiler ZKIR v2 codegen. Lines 9350-9676 contain the FIXMEs. |
| compactc | `compiler/zkir-v3-passes.ss` (if exists) | ZKIR v3 codegen with equivalent TODOs. |
| compact | `runtime/src/built-ins.ts` | JS field arithmetic (addField, subField, mulField). Single-reduction shortcuts. |
| compact | `runtime/src/compact-types.ts` | Type serialization (toValue/fromValue). Bytes trailing zero truncation at line 379. |
| compact | `runtime/src/circuit-context.ts` | CircuitContext and ProofData construction. |
| compact | `test-center/key-provider.ts` | `checkProofData()` — the JS→ZKIR validation bridge. |
| midnight-ledger | `zkir/src/ir_vm.rs` | ZKIR v2 preprocessing: `preprocess()`, `resolve_operand_bits()` at line 264. |
| midnight-ledger | `zkir-v3/src/ir_vm.rs` | ZKIR v3 preprocessing (same logic, named identifiers). |
| midnight-ledger | `zkir/tests/proofs.rs` | Proven boundary tests for DIV-001, DIV-004, RT-004. |

## Divergence categories

Beyond the compiler bugs (DIV-*), these runtime-level divergences were identified by analyzing `compact-runtime` vs `ir_vm.rs`:

1. **Boolean encoding asymmetry** — `toValue(false)` produces empty array, ZKIR expects field 0
2. **Bytes trailing zero truncation** — `CompactTypeBytes.toValue()` strips trailing 0x00
3. **Field negation** — JS manual mod vs ZKIR native Fr
4. **LessThan bit-based comparison** — ZKIR truncates to N bits before comparing
5. **Persistent hash alignment parsing** — ZKIR re-parses field→alignment→binary, JS hashes AlignedValue directly
6. **Transient hash input encoding** — JS type.toValue() overhead vs ZKIR raw field elements
7. **Type serialization round-trip** — toValue/fromValue asymmetry
8. **Public transcript ordering** — event filtering vs index-based matching
9. **Field arithmetic overflow** — JS addField single-subtraction vs native Fr
10. **Enum encoding** — Field encoding in toValue vs byte reconstruction in fromValue

These are documented in detail in the exploration agent output from the original investigation session. Not all are proven to cause real-world failures — they are theoretical risks identified by code review. The linter flags patterns associated with categories 1, 5, 6, 9 via the RT-* rules.
