export { analyzeFile } from "./analyze.js";
export { buildIrGraph, buildZeroAnalysis, guardDepth } from "./ir.js";
export { ALL_RULES } from "./rules.js";
export { formatSummary, exitCode, type Format } from "./format.js";
export type {
  Zkir,
  ZkirV2,
  ZkirV3,
  Finding,
  CircuitReport,
  CircuitStats,
  ScanSummary,
  Severity,
} from "./types.js";
