/**
 * Template for differential fuzz testing a Compact contract.
 *
 * Copy this file into your contract's test directory and fill in:
 * 1. Contract import and constructor
 * 2. Witness implementation
 * 3. Circuit calls with test inputs
 *
 * The checkProofDataAgainstZkir() function is the core: it serializes
 * ProofData from the JS circuit execution and validates it against
 * the ZKIR preprocessing (the same WASM code path as the proof server).
 *
 * If JS succeeds but ZKIR fails → divergence bug found.
 *
 * Prerequisites:
 *   npm install @midnight-ntwrk/compact-runtime @midnight-ntwrk/zkir-v2
 *   # or zkir-v3 depending on your ZKIR version
 */
import {
  proofDataIntoSerializedPreimage,
  createConstructorContext,
  CostModel,
  QueryContext,
  dummyContractAddress,
  type CircuitContext,
} from '@midnight-ntwrk/compact-runtime';
import {
  check as checkV2,
  jsonIrToBinary as jsonIrToBinaryV2,
} from '@midnight-ntwrk/zkir-v2';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Fill these in for your contract ────────────────────────────
//
// import { Contract } from './artifacts/YourContract/contract/index.js';
// import { YourWitnesses } from './witnesses/YourContract.js';
//
// const CONTRACT_DIR = './artifacts/YourContract';
// const CONSTRUCTOR_ARGS = ['arg1', 'arg2'];
// ─────────────────────────────────────────────────────────────────

/**
 * Validate ProofData against the ZKIR using the WASM check pipeline.
 *
 * This runs the exact same code as the proof server's /check endpoint:
 *   ProofData → proofDataIntoSerializedPreimage → checkV2/checkV3
 *     → IrSource::check() → preprocess() → resolve_operand_bits()
 *
 * If this passes, the proof server will accept the proof.
 * If this fails but the JS circuit succeeded, you've found a divergence.
 */
export async function checkProofDataAgainstZkir(
  contractDir: string,
  circuitName: string,
  proofData: {
    input: unknown;
    output: unknown;
    publicTranscript: unknown;
    privateTranscriptOutputs: unknown;
  },
): Promise<void> {
  const zkirPath = join(contractDir, 'zkir', `${circuitName}.zkir`);
  const zkirJson = readFileSync(zkirPath, 'utf-8');

  // Detect version
  const version = JSON.parse(zkirJson).version;
  const irBinary = jsonIrToBinaryV2(zkirJson);
  // For v3: use jsonIrToBinaryV3 and checkV3 instead

  const preimage = proofDataIntoSerializedPreimage(
    proofData.input,
    proofData.output,
    proofData.publicTranscript,
    proofData.privateTranscriptOutputs,
    circuitName,
  );

  const keyProvider = {
    lookupKey: async () => ({
      proverKey: new Uint8Array(0),
      verifierKey: new Uint8Array(0),
      ir: irBinary,
    }),
    getParams: async () => new Uint8Array(0),
  };

  await checkV2(preimage, keyProvider);
}

/**
 * Create a raw contract instance that returns full CircuitResults
 * including proofData. The compact-tools-simulator proxy strips
 * proofData, so we bypass it here.
 *
 * Usage:
 *   const { callCircuit } = createRawContract(Contract, witnesses, ...args);
 *   const result = callCircuit('myCircuit', arg1, arg2);
 *   await checkProofDataAgainstZkir(CONTRACT_DIR, 'myCircuit', result.proofData);
 */
export function createRawContract<PS>(
  ContractClass: new (witnesses: unknown) => {
    initialState: (...args: unknown[]) => {
      currentPrivateState: PS;
      currentContractState: { data: unknown };
      currentZswapLocalState: { coinPublicKey: string };
    };
    circuits: Record<string, (...args: unknown[]) => {
      result: unknown;
      proofData: unknown;
      context: {
        currentPrivateState: PS;
        currentZswapLocalState: unknown;
        currentQueryContext: unknown;
        costModel: unknown;
      };
    }>;
  },
  witnesses: unknown,
  privateState: PS,
  constructorArgs: unknown[],
) {
  const contract = new ContractClass(witnesses);
  const coinPK = '0'.repeat(64);

  const initCtx = createConstructorContext(privateState, coinPK);
  const initResult = contract.initialState(initCtx, ...constructorArgs);

  const chargedState = initResult.currentContractState.data;
  const contractAddress = dummyContractAddress();

  let context = {
    currentPrivateState: initResult.currentPrivateState,
    currentZswapLocalState: initResult.currentZswapLocalState,
    currentQueryContext: new QueryContext(chargedState, contractAddress),
    costModel: CostModel.initialCostModel(),
  };

  return {
    contract,
    callCircuit(circuitName: string, ...args: unknown[]) {
      const circuit = contract.circuits[circuitName];
      if (!circuit) {
        throw new Error(
          `Circuit '${circuitName}' not found. Available: ${Object.keys(contract.circuits).join(', ')}`,
        );
      }

      const result = circuit(
        context as unknown as CircuitContext<PS>,
        ...args,
      );

      // Update context for stateful circuits
      context = {
        currentPrivateState: result.context.currentPrivateState,
        currentZswapLocalState: result.context.currentZswapLocalState,
        currentQueryContext: result.context.currentQueryContext,
        costModel: result.context.costModel,
      };

      return result;
    },

    reset() {
      const fresh = contract.initialState(
        createConstructorContext(privateState, coinPK),
        ...constructorArgs,
      );
      context = {
        currentPrivateState: fresh.currentPrivateState,
        currentZswapLocalState: fresh.currentZswapLocalState,
        currentQueryContext: new QueryContext(
          fresh.currentContractState.data,
          contractAddress,
        ),
        costModel: CostModel.initialCostModel(),
      };
    },
  };
}
