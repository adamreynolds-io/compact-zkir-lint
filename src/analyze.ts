/**
 * Core analysis engine. Loads a ZKIR file, builds the IR graph,
 * runs all rules, and produces a CircuitReport.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { buildIrGraph, estimateK, guardDepth } from "./ir.js";
import {
  profileCircuit,
  type EnvironmentConfig,
  type ProfileOptions,
} from "./profile.js";
import { ALL_PERF_RULES, ALL_RULES, checkWasmKLimit } from "./rules.js";
import type {
  CircuitReport,
  CircuitStats,
  Finding,
  RowCost,
  Zkir,
  ZkirV2,
  ZkirV3,
} from "./types.js";

function computeStats(zkir: Zkir): CircuitStats {
  const insts = zkir.instructions;
  const numInputs =
    zkir.version.major === 2
      ? (zkir as ZkirV2).num_inputs
      : (zkir as ZkirV3).inputs.length;

  let constrainBitsCount = 0;
  let assertCount = 0;
  let condSelectCount = 0;
  let privateInputCount = 0;
  let reconstitueFieldCount = 0;
  let divModCount = 0;
  const guardSet = new Set<number>();

  for (const inst of insts) {
    switch (inst.op) {
      case "constrain_bits":
        constrainBitsCount++;
        break;
      case "assert":
        assertCount++;
        break;
      case "cond_select":
        condSelectCount++;
        break;
      case "private_input":
        privateInputCount++;
        if (inst.guard != null) guardSet.add(inst.guard as number);
        break;
      case "reconstitute_field":
        reconstitueFieldCount++;
        break;
      case "div_mod_power_of_two":
        divModCount++;
        break;
    }
  }

  const graph = buildIrGraph(zkir);
  let maxGuardDepthVal = 0;
  for (const guard of graph.guards) {
    maxGuardDepthVal = Math.max(maxGuardDepthVal, guardDepth(graph, guard));
  }

  return {
    totalInstructions: insts.length,
    numInputs,
    constrainBitsCount,
    assertCount,
    condSelectCount,
    privateInputCount,
    guardedRegions: guardSet.size,
    maxGuardDepth: maxGuardDepthVal,
    reconstitueFieldCount,
    divModCount,
  };
}

export interface AnalyzeOptions {
  profile?: boolean;
  targets?: string[];
  kSource?: "estimate" | "wasm" | "auto";
  maxK?: number;
  environments?: Record<string, EnvironmentConfig>;
  rowCosts?: Record<string, RowCost>;
}

export async function analyzeFile(
  filePath: string,
  options: AnalyzeOptions = {},
): Promise<CircuitReport> {
  const raw = readFileSync(filePath, "utf-8");
  const parsed: { version: { major: number; minor: number } } = JSON.parse(raw);
  const name = basename(filePath, ".zkir");

  if (parsed.version.major !== 2 && parsed.version.major !== 3) {
    return {
      file: filePath,
      name,
      version: parsed.version.major,
      k: 0,
      stats: {
        totalInstructions: 0,
        numInputs: 0,
        constrainBitsCount: 0,
        assertCount: 0,
        condSelectCount: 0,
        privateInputCount: 0,
        guardedRegions: 0,
        maxGuardDepth: 0,
        reconstitueFieldCount: 0,
        divModCount: 0,
      },
      findings: [
        {
          severity: "warn",
          rule: "PARSE",
          instructionIndex: -1,
          memoryVar: null,
          message: `Unsupported ZKIR version ${parsed.version.major}.${parsed.version.minor}`,
          details: "Only ZKIR v2 and v3 are supported.",
        },
      ],
    };
  }

  const zkir = parsed as Zkir;

  const stats = computeStats(zkir);
  const graph = buildIrGraph(zkir);

  const findings: Finding[] = [];
  for (const rule of ALL_RULES) {
    findings.push(...rule(graph));
  }

  // Always compute k and check WASM hard limit
  const est = estimateK(zkir, options.rowCosts);
  const wasmFinding = checkWasmKLimit(est.k);
  if (wasmFinding) {
    findings.push(wasmFinding);
  }

  const report: CircuitReport = {
    file: filePath,
    name,
    version: zkir.version.major,
    k: est.k,
    stats,
    findings,
  };

  if (options.profile) {
    const profileOpts: ProfileOptions = {
      targets: options.targets,
      kSource: options.kSource,
      rawJson: raw,
      maxK: options.maxK,
      environments: options.environments,
      costOverrides: options.rowCosts,
    };
    report.profile = await profileCircuit(zkir, profileOpts);

    for (const perfRule of ALL_PERF_RULES) {
      findings.push(...perfRule(report.profile));
    }
  }

  return report;
}
