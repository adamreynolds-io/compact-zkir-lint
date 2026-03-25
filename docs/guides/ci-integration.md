# CI Integration

compact-zkir-lint is designed for CI pipelines. It exits non-zero when errors are found and supports SARIF output for GitHub Code Scanning.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | No errors found (warnings and info are allowed) |
| 1 | One or more errors found |

## Basic CI usage

```bash
# Fail the build if any circuit has errors
npx compact-zkir-lint -r contracts/src/artifacts/

# Only report errors (skip warnings and info)
npx compact-zkir-lint -r contracts/src/artifacts/ --severity error

# Quiet mode — summary line only
npx compact-zkir-lint -r contracts/src/artifacts/ -q
```

## SARIF output for GitHub Code Scanning

[SARIF](https://sarifweb.azurewebsites.net/) integrates with GitHub's code scanning alerts.

```bash
npx compact-zkir-lint -r contracts/src/artifacts/ --format sarif > results.sarif
```

### GitHub Actions workflow

```yaml
name: ZKIR Lint
on: [push, pull_request]

jobs:
  zkir-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>  # pin to SHA
      - uses: actions/setup-node@<sha>
        with:
          node-version: 22

      - name: Compile contracts
        run: compact compile src/MyContract.compact src/artifacts/MyContract

      - name: Run ZKIR lint
        run: npx compact-zkir-lint -r src/artifacts/ --format sarif > zkir-lint.sarif
        continue-on-error: true

      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@<sha>
        with:
          sarif_file: zkir-lint.sarif
```

## JSON output

For programmatic consumption in custom CI scripts:

```bash
npx compact-zkir-lint -r contracts/src/artifacts/ --format json
```

The JSON output includes full finding details — rule, severity, instruction index, memory variable, message, and details.

## Recommended CI strategy

1. **On every PR**: Run with `--severity error` to catch proof-breaking issues
2. **Nightly**: Run with `--severity info` to track code quality trends
3. **After compiler upgrades**: Run against all circuits and compare output to baseline

## Monorepo usage

Scan multiple artifact directories:

```bash
npx compact-zkir-lint -r packages/*/src/artifacts/
```

Or scan the entire workspace:

```bash
npx compact-zkir-lint -r . --severity error
```

The linter skips `node_modules`, `.git`, and dotfile directories automatically.
