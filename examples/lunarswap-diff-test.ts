/**
 * Differential fuzz test for LunarSwap circuits.
 *
 * Runs circuits through compact-runtime (JS) then validates the ProofData
 * against the ZKIR preprocessing (WASM) — the exact same code path as the
 * proof server's /check endpoint. Any case where JS succeeds but ZKIR
 * fails is a divergence bug.
 *
 * This exercises the pipeline:
 *   compact-runtime → ProofData → proofDataIntoSerializedPreimage → checkV2
 */
import {
  encodeCoinPublicKey,
  proofDataIntoSerializedPreimage,
  type CircuitContext,
  createCircuitContext,
  createConstructorContext,
  CostModel,
  QueryContext,
} from '@midnight-ntwrk/compact-runtime';
import * as ocrt from '@midnight-ntwrk/compact-runtime';
import {
  check as checkV2,
  jsonIrToBinary as jsonIrToBinaryV2,
} from '@midnight-ntwrk/zkir-v2';
import {
  Contract,
  ledger,
  type ShieldedCoinInfo,
  type Either,
  type ZswapCoinPublicKey,
  type ContractAddress,
} from '@src/artifacts/lunarswap/Lunarswap/contract/index.js';
import { ShieldedFungibleTokenSimulator } from '@src/shielded-token/test/mocks/ShieldedFungibleTokenSimulator.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import {
  LunarswapPrivateState,
  LunarswapWitnessesImp,
} from '../witnesses/Lunarswap.js';

const NONCE = new Uint8Array(32).fill(0x44);
const DOMAIN_USDC = new Uint8Array(32).fill(0x01);
const DOMAIN_NIGHT = new Uint8Array(32).fill(0x02);
const LP_USER =
  'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';

const createEitherFromHex = (hexString: string) => ({
  is_left: true,
  left: { bytes: encodeCoinPublicKey(hexString) },
  right: { bytes: new Uint8Array(32) },
});

const CONTRACT_DIR = join(
  import.meta.dirname,
  '../../artifacts/lunarswap/Lunarswap',
);

/**
 * Validate ProofData against the ZKIR using the WASM check pipeline.
 * Same flow as compact/test-center/key-provider.ts:checkProofData.
 */
async function checkProofDataAgainstZkir(
  circuitName: string,
  proofData: {
    input: unknown;
    output: unknown;
    publicTranscript: unknown;
    privateTranscriptOutputs: unknown;
  },
): Promise<void> {
  const zkirPath = join(CONTRACT_DIR, 'zkir', `${circuitName}.zkir`);
  const zkirJson = readFileSync(zkirPath, 'utf-8');
  const irBinary = jsonIrToBinaryV2(zkirJson);

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
 * Create a raw contract + context that returns full CircuitResults
 * including proofData (the simulator proxy strips this).
 */
function createRawContract() {
  const witnesses = LunarswapWitnessesImp();
  const contract = new Contract<LunarswapPrivateState>(witnesses);
  const privateState = LunarswapPrivateState.generate();
  const coinPK = '0'.repeat(64);

  const initCtx = createConstructorContext(privateState, coinPK);
  const {
    currentPrivateState,
    currentContractState,
    currentZswapLocalState,
  } = contract.initialState(initCtx, 'LP', 'LP', NONCE, 18n);

  const chargedState = currentContractState.data;
  const contractAddress = ocrt.dummyContractAddress();

  let context = {
    currentPrivateState,
    currentZswapLocalState,
    currentQueryContext: new QueryContext(chargedState, contractAddress),
    costModel: CostModel.initialCostModel(),
  };

  return {
    contract,
    getContext: () => context,
    callAddLiquidity(
      tokenA: ShieldedCoinInfo,
      tokenB: ShieldedCoinInfo,
      amountAMin: bigint,
      amountBMin: bigint,
      to: Either<ZswapCoinPublicKey, ContractAddress>,
    ) {
      const result = contract.circuits.addLiquidity(
        context as unknown as CircuitContext<LunarswapPrivateState>,
        tokenA,
        tokenB,
        amountAMin,
        amountBMin,
        to,
      );
      // Update context for next call
      context = {
        currentPrivateState: result.context.currentPrivateState,
        currentZswapLocalState: result.context.currentZswapLocalState,
        currentQueryContext: result.context.currentQueryContext,
        costModel: result.context.costModel,
      };
      return result; // Full result including proofData
    },
  };
}

describe('LunarSwap differential fuzz testing', () => {
  describe('addLiquidity: JS vs ZKIR validation', () => {
    it('basic liquidity provision', async () => {
      const { callAddLiquidity } = createRawContract();
      const usdc = new ShieldedFungibleTokenSimulator(
        NONCE, 'USDC', 'USDC', DOMAIN_USDC,
      );
      const night = new ShieldedFungibleTokenSimulator(
        NONCE, 'Night', 'NIGHT', DOMAIN_NIGHT,
      );

      const usdcCoin = usdc.mint(createEitherFromHex(LP_USER), 2000n);
      const nightCoin = night.mint(createEitherFromHex(LP_USER), 1000n);
      const result = callAddLiquidity(
        usdcCoin, nightCoin, 0n, 0n, createEitherFromHex(LP_USER),
      );

      console.log('JS result:', result.result);
      await checkProofDataAgainstZkir('addLiquidity', result.proofData);
      console.log('ZKIR check: PASSED');
    });

    it('second liquidity provision (exercises subU128)', async () => {
      const { callAddLiquidity } = createRawContract();
      const usdc = new ShieldedFungibleTokenSimulator(
        NONCE, 'USDC', 'USDC', DOMAIN_USDC,
      );
      const night = new ShieldedFungibleTokenSimulator(
        NONCE, 'Night', 'NIGHT', DOMAIN_NIGHT,
      );
      const to = createEitherFromHex(LP_USER);

      // First add
      callAddLiquidity(
        usdc.mint(createEitherFromHex(LP_USER), 2000n),
        night.mint(createEitherFromHex(LP_USER), 1000n),
        0n, 0n, to,
      );

      // Second add — triggers subU128 in Uint128_div verification
      const result = callAddLiquidity(
        usdc.mint(createEitherFromHex(LP_USER), 2000n),
        night.mint(createEitherFromHex(LP_USER), 1000n),
        0n, 0n, to,
      );

      console.log('JS result:', result.result);
      await checkProofDataAgainstZkir('addLiquidity', result.proofData);
      console.log('ZKIR check: PASSED');
    });

    it('equal amounts (a.low == b.low case in subU128)', async () => {
      const { callAddLiquidity } = createRawContract();
      const usdc = new ShieldedFungibleTokenSimulator(
        NONCE, 'USDC', 'USDC', DOMAIN_USDC,
      );
      const night = new ShieldedFungibleTokenSimulator(
        NONCE, 'Night', 'NIGHT', DOMAIN_NIGHT,
      );

      const result = callAddLiquidity(
        usdc.mint(createEitherFromHex(LP_USER), 5000n),
        night.mint(createEitherFromHex(LP_USER), 5000n),
        0n, 0n, createEitherFromHex(LP_USER),
      );

      console.log('JS result:', result.result);
      await checkProofDataAgainstZkir('addLiquidity', result.proofData);
      console.log('ZKIR check: PASSED');
    });

    it('large amounts (stress Uint128 math)', async () => {
      const { callAddLiquidity } = createRawContract();
      const usdc = new ShieldedFungibleTokenSimulator(
        NONCE, 'USDC', 'USDC', DOMAIN_USDC,
      );
      const night = new ShieldedFungibleTokenSimulator(
        NONCE, 'Night', 'NIGHT', DOMAIN_NIGHT,
      );

      const result = callAddLiquidity(
        usdc.mint(createEitherFromHex(LP_USER), 1000000000000n),
        night.mint(createEitherFromHex(LP_USER), 999999999999n),
        0n, 0n, createEitherFromHex(LP_USER),
      );

      console.log('JS result:', result.result);
      await checkProofDataAgainstZkir('addLiquidity', result.proofData);
      console.log('ZKIR check: PASSED');
    });

    it('asymmetric reserves with second add', async () => {
      const { callAddLiquidity } = createRawContract();
      const usdc = new ShieldedFungibleTokenSimulator(
        NONCE, 'USDC', 'USDC', DOMAIN_USDC,
      );
      const night = new ShieldedFungibleTokenSimulator(
        NONCE, 'Night', 'NIGHT', DOMAIN_NIGHT,
      );
      const to = createEitherFromHex(LP_USER);

      // Asymmetric first add
      callAddLiquidity(
        usdc.mint(createEitherFromHex(LP_USER), 100n),
        night.mint(createEitherFromHex(LP_USER), 10000n),
        0n, 0n, to,
      );

      // Second add with proportional ratio
      const result = callAddLiquidity(
        usdc.mint(createEitherFromHex(LP_USER), 50n),
        night.mint(createEitherFromHex(LP_USER), 5000n),
        0n, 0n, to,
      );

      console.log('JS result:', result.result);
      await checkProofDataAgainstZkir('addLiquidity', result.proofData);
      console.log('ZKIR check: PASSED');
    });
  });
});
