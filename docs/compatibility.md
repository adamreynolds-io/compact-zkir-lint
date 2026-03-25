# Compatibility and Version Tracking

## Tested versions

| Component | Tested versions | Notes |
|-----------|----------------|-------|
| **Compact compiler** | 0.30.0 | ZKIR v2 output. Earlier versions (0.28.0, 0.29.0) produce the same patterns. |
| **compact-runtime** | 0.15.0 | The JS runtime that executes circuits client-side. |
| **ZKIR format** | v2 (`"major": 2`) | What the compiler produces by default. v3 support planned (same bugs exist per compiler FIXMEs). |
| **Ledger** | v8 (ledger-v8 8.0.3) | The proof server and onchain-runtime version. |
| **Node.js** | >= 18 | For running the linter. Zero Midnight package dependencies. |

## Compiler version status

The bugs detected by this tool are in the **Compact compiler's ZKIR codegen**, not in the runtime or proof server. They persist until the compiler team resolves [compact#226](https://github.com/LFDT-Minokawa/compact/issues/226).

| Compiler version | Status | Notes |
|-----------------|--------|-------|
| 0.28.0 | Affected | First version tested with these patterns |
| 0.29.0 | Affected | Same codegen, constraint count regression in some casts ([compact#81](https://github.com/LFDT-Minokawa/compact/issues/81)) |
| 0.30.0 | **Affected** | Current release. All patterns confirmed. LunarSwap hit this in production. |
| 0.31.0 (planned) | Unknown | May switch to ZKIR v3 backend ([compact#86](https://github.com/LFDT-Minokawa/compact/issues/86)). Same FIXMEs exist in v3 codegen (`zkir-v3-passes.ss:672, 765, 782`). |

## When to re-run

Re-run the linter when:

- **New compiler version ships** — recompile your contracts, re-lint, compare error counts
- **You change Compact source** — recompile and re-lint affected circuits
- **New linter version** — may add rules or improve detection accuracy

```bash
compact compile +NEW_VERSION src/MyContract.compact src/artifacts/MyContract
npx compact-zkir-lint -r src/artifacts/ --severity info
```

## ZKIR v3 support

The compiler may switch to ZKIR v3 output in a future release ([compact#86](https://github.com/LFDT-Minokawa/compact/issues/86)). The same divergence bugs exist in the v3 codegen — the compiler FIXMEs are present in both `passes.ss` (v2) and `zkir-v3-passes.ss` (v3).

v3 format differences:
- Named identifiers (`%v_0`) instead of numeric indices
- Typed inputs (`{ "name": "%v_0", "type": "Scalar<BLS12-381>" }`)
- Similar instruction set with different field names (e.g., `val` instead of `var` in constrain_bits)

The linter currently supports v2 only. v3 support will be added when a compiler version ships v3 output.

## References

- [compact#250](https://github.com/LFDT-Minokawa/compact/issues/250) — Original bug report (LunarSwap addLiquidity)
- [compact#226](https://github.com/LFDT-Minokawa/compact/issues/226) — Compiler tracking issue (assigned, open)
- [compact#253](https://github.com/LFDT-Minokawa/compact/issues/253) — Detailed root cause analysis
- [midnight-apps#309](https://github.com/OpenZeppelin/midnight-apps/pull/309) — OpenZeppelin's interim fix for Uint128.subU128
