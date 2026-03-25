/**
 * Test harness that integrates compact-runtime circuit execution
 * with ZKIR proof validation for differential fuzz testing.
 *
 * Usage from a test file or script that has access to the Midnight packages:
 *
 * ```typescript
 * import { createHarness, fuzzCircuit } from 'zkir-lint/harness';
 * import { Contract, ledger } from './artifacts/MyContract/contract/index.js';
 * import { proofDataIntoSerializedPreimage } from '@midnight-ntwrk/onchain-runtime-v3';
 * import { check as checkV2 } from '@midnight-ntwrk/zkir-v2';
 * import { createCircuitContext, createConstructorContext } from '@midnight-ntwrk/compact-runtime';
 *
 * const harness = createHarness({
 *   contractDir: './artifacts/MyContract',
 *   contract: new Contract(myWitnesses),
 *   initialState: (contract) => {
 *     const ctx = createConstructorContext({}, '0'.repeat(64));
 *     return contract.initialState(ctx, ...constructorArgs);
 *   },
 *   createContext: (contractState, privateState, zswapState) => {
 *     return createCircuitContext(dummyAddress, coinPK, contractState, privateState);
 *   },
 *   checkProofData: async (circuitName, proofData) => {
 *     // Wire up the check pipeline
 *     const preimage = proofDataIntoSerializedPreimage(
 *       proofData.input, proofData.output,
 *       proofData.publicTranscript, proofData.privateTranscriptOutputs,
 *       circuitName
 *     );
 *     const keyProvider = createKeyMaterialProvider(contractDir);
 *     return checkV2(preimage, keyProvider);
 *   },
 * });
 *
 * // Fuzz a specific circuit
 * const results = await fuzzCircuit(harness, 'addLiquidity', {
 *   inputGenerator: (constraints) => generateFuzzInputs(zkir, 100),
 *   verbose: true,
 * });
 * ```
 */

import type { FuzzInput } from "./fuzz.js";
import { runDiffTests, formatDiffSummary, type DiffSummary } from "./diff.js";

/** Configuration for the test harness. */
export interface HarnessConfig {
  /** Path to the compiled contract directory (containing contract/ and zkir/). */
  contractDir: string;

  /**
   * The compiled Compact contract instance.
   * Must have `impureCircuits` and `circuits` properties.
   */
  contract: {
    impureCircuits: Record<string, (...args: unknown[]) => unknown>;
    circuits: Record<string, (...args: unknown[]) => unknown>;
    initialState: (...args: unknown[]) => {
      currentContractState: unknown;
      currentPrivateState: unknown;
      currentZswapLocalState: { coinPublicKey: string };
    };
  };

  /**
   * Initialize the contract and return the constructor result.
   * Called once to set up the initial state.
   */
  initialState: (contract: HarnessConfig["contract"]) => {
    currentContractState: unknown;
    currentPrivateState: unknown;
    currentZswapLocalState: { coinPublicKey: string };
  };

  /**
   * Create a CircuitContext from contract state.
   * Called before each circuit execution.
   */
  createContext: (
    contractState: unknown,
    privateState: unknown,
    coinPublicKey: string,
  ) => unknown;

  /**
   * Check ProofData against the ZKIR.
   * This should call proofDataIntoSerializedPreimage + checkV2/checkV3.
   */
  checkProofData: (
    circuitName: string,
    proofData: unknown,
  ) => Promise<unknown>;
}

/** A configured harness ready for differential testing. */
export interface Harness {
  config: HarnessConfig;
  /** Current circuit context (updated after each circuit call). */
  context: unknown;
  /** Current contract state. */
  contractState: unknown;
  /** Current private state. */
  privateState: unknown;
  /** Execute a circuit with given inputs. */
  execute: (
    circuitName: string,
    inputs: bigint[],
  ) => { proofData: unknown; result: unknown };
  /** Check ProofData against ZKIR. */
  check: (circuitName: string, proofData: unknown) => Promise<unknown>;
  /** Reset to initial state. */
  reset: () => void;
}

/**
 * Create a test harness for a compiled Compact contract.
 */
export function createHarness(config: HarnessConfig): Harness {
  let contractState: unknown;
  let privateState: unknown;
  let coinPublicKey: string;
  let context: unknown;

  function init() {
    const initResult = config.initialState(config.contract);
    contractState = initResult.currentContractState;
    privateState = initResult.currentPrivateState;
    coinPublicKey = initResult.currentZswapLocalState.coinPublicKey;
    context = config.createContext(contractState, privateState, coinPublicKey);
  }

  init();

  return {
    config,
    get context() {
      return context;
    },
    get contractState() {
      return contractState;
    },
    get privateState() {
      return privateState;
    },

    execute(circuitName: string, inputs: bigint[]) {
      const allCircuits = {
        ...config.contract.circuits,
        ...config.contract.impureCircuits,
      };
      const circuit = allCircuits[circuitName];
      if (!circuit) {
        throw new Error(
          `Circuit '${circuitName}' not found. Available: ${Object.keys(allCircuits).join(", ")}`,
        );
      }

      const circuitResult = (circuit as (...args: unknown[]) => {
        result: unknown;
        proofData: unknown;
        context: unknown;
      })(context, ...inputs);

      // Update context for stateful circuits
      if (circuitResult.context) {
        context = circuitResult.context;
      }

      return {
        proofData: circuitResult.proofData,
        result: circuitResult.result,
      };
    },

    async check(circuitName: string, proofData: unknown) {
      return config.checkProofData(circuitName, proofData);
    },

    reset() {
      init();
    },
  };
}

/**
 * Run a fuzz campaign on a single circuit using the harness.
 */
export async function fuzzCircuit(
  harness: Harness,
  circuitName: string,
  options: {
    inputs: FuzzInput[];
    stopOnDivergence?: boolean;
    verbose?: boolean;
    resetBetweenRuns?: boolean;
  },
): Promise<DiffSummary> {
  const summary = await runDiffTests(
    {
      executeCircuit: (name, values) => {
        if (options.resetBetweenRuns) {
          harness.reset();
        }
        return harness.execute(name, values);
      },
      checkProof: (name, proofData) => harness.check(name, proofData),
    },
    circuitName,
    options.inputs,
    {
      stopOnDivergence: options.stopOnDivergence,
      verbose: options.verbose,
    },
  );

  if (options.verbose) {
    console.log("\n" + formatDiffSummary(summary));
  }

  return summary;
}
