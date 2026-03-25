/**
 * Capture proof payloads for all benchmark circuits (k=10..15).
 */

import { writeFileSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { CompiledContract } from "@midnight-ntwrk/compact-js";
import {
  createConstructorContext,
  type CoinPublicKey,
} from "@midnight-ntwrk/compact-runtime";
import {
  LedgerParameters,
  sampleCoinPublicKey,
  sampleContractAddress,
  sampleEncryptionPublicKey,
  ZswapChainState,
  proofDataIntoSerializedPreimage,
  createProvingPayload,
} from "@midnight-ntwrk/ledger-v8";
import { createUnprovenCallTxFromInitialStates } from "@midnight-ntwrk/midnight-js-contracts";
import { getNetworkId, setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  createZKIR,
  createProverKey,
  createVerifierKey,
  ZKConfigProvider,
  type ZKIR,
  type ProverKey,
  type VerifierKey,
} from "@midnight-ntwrk/midnight-js-types";
import { parseCoinPublicKeyToHex } from "@midnight-ntwrk/midnight-js-utils";

import { estimateK } from "../src/ir.js";

const CONTRACT_DIR = join(import.meta.dirname, "benchmark-compiled");
const OUTPUT_DIR = join(import.meta.dirname, "fixtures");

function createZKConfigProvider(): ZKConfigProvider<string> {
  return new (class extends ZKConfigProvider<string> {
    async getZKIR(circuitId: string): Promise<ZKIR> {
      return createZKIR(
        await readFile(join(CONTRACT_DIR, "zkir", `${circuitId}.bzkir`)),
      );
    }
    async getProverKey(circuitId: string): Promise<ProverKey> {
      return createProverKey(
        await readFile(join(CONTRACT_DIR, "keys", `${circuitId}.prover`)),
      );
    }
    async getVerifierKey(circuitId: string): Promise<VerifierKey> {
      return createVerifierKey(
        await readFile(join(CONTRACT_DIR, "keys", `${circuitId}.verifier`)),
      );
    }
  })();
}

async function main(): Promise<void> {
  setNetworkId("undeployed");

  const coinPublicKey = sampleCoinPublicKey();
  const contractModule = await import(
    join(CONTRACT_DIR, "contract", "index.js")
  );

  // Witness that returns a dummy Secret { value: Bytes<32> }
  const dummySecret = {
    value: new Uint8Array(32),
  };

  const constructorResult = new contractModule.Contract({
    getSecret: () => dummySecret,
  }).initialState(
    createConstructorContext(
      undefined,
      parseCoinPublicKeyToHex(coinPublicKey, getNetworkId()),
    ),
  );

  const zkConfigProvider = createZKConfigProvider();
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const circuits = readdirSync(join(CONTRACT_DIR, "zkir"))
    .filter((f) => f.endsWith(".zkir"))
    .map((f) => f.replace(".zkir", ""))
    .sort();

  console.log(`Capturing ${circuits.length} circuits...\n`);

  for (const circuitId of circuits) {
    process.stdout.write(`${circuitId}: `);

    try {
      const result = await createUnprovenCallTxFromInitialStates(
        zkConfigProvider,
        {
          compiledContract: CompiledContract.make(
            "benchmark",
            contractModule.Contract,
          ).pipe(
            CompiledContract.withWitnesses({
              getSecret: (ctx: any) => [ctx.privateState, dummySecret],
            }),
          ) as any,
          circuitId,
          contractAddress: sampleContractAddress(),
          coinPublicKey,
          initialContractState: constructorResult.currentContractState,
          initialZswapChainState: new ZswapChainState(),
          ledgerParameters: LedgerParameters.initialParameters(),
          args: [],
        },
        sampleEncryptionPublicKey(),
      );

      const preimage = proofDataIntoSerializedPreimage(
        result.private.input,
        result.private.output,
        result.public.publicTranscript,
        result.private.privateTranscriptOutputs,
        circuitId,
      );

      const keyMaterial = {
        proverKey: createProverKey(
          readFileSync(join(CONTRACT_DIR, "keys", `${circuitId}.prover`)),
        ),
        verifierKey: createVerifierKey(
          readFileSync(join(CONTRACT_DIR, "keys", `${circuitId}.verifier`)),
        ),
        ir: createZKIR(
          readFileSync(join(CONTRACT_DIR, "zkir", `${circuitId}.bzkir`)),
        ),
      };

      const payload = createProvingPayload(preimage, undefined, keyMaterial);

      const zkirJson = readFileSync(
        join(CONTRACT_DIR, "zkir", `${circuitId}.zkir`),
        "utf-8",
      );
      const est = estimateK(JSON.parse(zkirJson));

      const fixtureBase = `k${est.k}-benchmark-${circuitId}`;
      writeFileSync(join(OUTPUT_DIR, `${fixtureBase}.bin`), payload);
      const zkir = JSON.parse(zkirJson);
      writeFileSync(
        join(OUTPUT_DIR, `${fixtureBase}.meta.json`),
        JSON.stringify(
          {
            k: est.k,
            circuit: circuitId,
            contract: "benchmark",
            rows: est.rows,
            tableRows: est.tableRows,
            hashes: est.hashCount,
            instructions: zkir.instructions.length,
            payloadBytes: payload.length,
            sdkVersion: "8.0.3",
            recordedAt: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
      );

      console.log(`k=${est.k}, ${payload.length} bytes`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAILED: ${msg}`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
