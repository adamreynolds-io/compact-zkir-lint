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
