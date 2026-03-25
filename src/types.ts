/** ZKIR v2 file format */
export interface ZkirV2 {
  version: { major: 2; minor: number };
  num_inputs: number;
  do_communications_commitment: boolean;
  instructions: Instruction[];
}

/** ZKIR v3 file format */
export interface ZkirV3 {
  version: { major: 3; minor: number };
  inputs: Array<{ name: string; type: string }>;
  do_communications_commitment: boolean;
  instructions: InstructionV3[];
}

export type Zkir = ZkirV2 | ZkirV3;

export interface Instruction {
  op: string;
  [key: string]: unknown;
}

export type InstructionV3 = Instruction;

export type Severity = "error" | "warn" | "info";

export interface Finding {
  severity: Severity;
  rule: string;
  instructionIndex: number;
  memoryVar: number | string | null;
  message: string;
  details: string;
}

export interface CircuitReport {
  file: string;
  name: string;
  version: number;
  stats: CircuitStats;
  findings: Finding[];
  profile?: CircuitProfile;
}

export interface CircuitStats {
  totalInstructions: number;
  numInputs: number;
  constrainBitsCount: number;
  assertCount: number;
  condSelectCount: number;
  privateInputCount: number;
  guardedRegions: number;
  maxGuardDepth: number;
  reconstitueFieldCount: number;
  divModCount: number;
}

export interface ScanSummary {
  totalFiles: number;
  totalErrors: number;
  totalWarnings: number;
  totalInfos: number;
  cleanFiles: number;
  reports: CircuitReport[];
}

/** Built-in proving environment names. Custom names are also allowed. */
export type ProvingTarget = string;

/** How the k value was determined. */
export type KSource = "exact-wasm" | "estimated";

/** Proving time estimate for a specific environment. */
export interface ProvingEstimate {
  environment: string;
  feasible: boolean;
  estimatedSeconds: [number, number];
  verdict: "ok" | "slow" | "infeasible";
}

/** Circuit performance profile. */
export interface CircuitProfile {
  k: number;
  kSource: KSource;
  rows: number;
  tableRows: number;
  hashCount: number;
  hashRows: number;
  ecOpCount: number;
  ecOpRows: number;
  estimates: ProvingEstimate[];
  /** User-defined maximum k (from --max-k). */
  maxK?: number;
}

/** Row cost for a single ZKIR instruction type. */
export interface RowCost {
  rows: number;
  tableRows: number;
}

/** K estimation result from the heuristic estimator. */
export interface KEstimate {
  k: number;
  rows: number;
  tableRows: number;
  hashCount: number;
  hashRows: number;
  ecOpCount: number;
  ecOpRows: number;
}
