// Static analysis
export { analyzeFile } from "./analyze.js";
export { buildIrGraph, buildZeroAnalysis, guardDepth } from "./ir.js";
export { ALL_RULES, ALL_PERF_RULES } from "./rules.js";
export { loadConfig, type LintConfig } from "./config.js";
export {
  profileCircuit,
  formatDuration,
  formatEstimateRange,
  DEFAULT_ENVIRONMENTS,
  type EnvironmentConfig,
  type TimingEntry,
} from "./profile.js";
export { estimateK } from "./ir.js";
export { formatSummary, exitCode, type Format } from "./format.js";

// Fuzz input generation
export {
  generateFuzzInputs,
  generateBranchTargetInputs,
  extractInputConstraints,
  extractBranchConditions,
  type FuzzInput,
  type InputConstraint,
} from "./fuzz.js";

// Differential testing
export {
  runDiffTests,
  formatDiffSummary,
  type DiffResult,
  type DiffSummary,
  type DiffDeps,
} from "./diff.js";

// Test harness
export {
  createHarness,
  fuzzCircuit,
  type HarnessConfig,
  type Harness,
} from "./harness.js";

// Types
export type {
  Zkir,
  ZkirV2,
  ZkirV3,
  Finding,
  CircuitReport,
  CircuitStats,
  CircuitProfile,
  ProvingEstimate,
  ProvingTarget,
  KEstimate,
  ScanSummary,
  Severity,
} from "./types.js";
