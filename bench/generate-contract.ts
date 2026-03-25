/**
 * Generate a Compact benchmark contract with circuits targeting k=10..20.
 *
 * Uses explicit persistentHash<Vector<2, Bytes<32>>>() calls — each
 * produces a persistent_hash instruction = 704 rows. This gives high k
 * with minimal instructions and small payloads.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const HASH_ROWS = 704;
const BASE_ROWS = 720;

interface Target {
  k: number;
  hashes: number;
}

const targets: Target[] = [];
for (let k = 10; k <= 18; k++) {
  const threshold = 2 ** (k - 1);
  const hashes = Math.max(0, Math.ceil((threshold - BASE_ROWS) / HASH_ROWS));
  targets.push({ k, hashes });
}

console.log("Target k values:");
for (const t of targets) {
  const estRows = BASE_ROWS + t.hashes * HASH_ROWS;
  console.log(`  k=${t.k}: ${t.hashes} hashes, ~${estRows} rows`);
}

let compact = `import CompactStandardLibrary;\n\n`;
compact += `// Auto-generated benchmark contract for k=10..20.\n`;
compact += `// Each circuit calls persistentHash N times.\n`;
compact += `// persistentHash = 704 rows/call in the proving circuit.\n\n`;

compact += `export ledger store: Counter;\n\n`;

// Helper circuit that chains hashes
// Each call: persistentHash<Vector<2, Bytes<32>>>([prev, seed])
// This produces one persistent_hash instruction per call

for (const t of targets) {
  compact += `// Target k=${t.k}: ${t.hashes} hashes\n`;
  compact += `export circuit bench_k${t.k}(): [] {\n`;
  compact += `  store.increment(1);\n`;

  if (t.hashes > 0) {
    // First hash seeds from a constant
    compact += `  const seed = pad(32, "bench");\n`;
    compact += `  const h0 = persistentHash<Vector<2, Bytes<32>>>([seed, seed]);\n`;

    // Chain subsequent hashes
    for (let i = 1; i < t.hashes; i++) {
      compact += `  const h${i} = persistentHash<Vector<2, Bytes<32>>>([h${i - 1}, seed]);\n`;
    }

    // Use the final hash so nothing is optimized away
    compact += `  store.increment(disclose(h${t.hashes - 1}[0]));\n`;
  }

  compact += `}\n\n`;
}

const outPath = join(import.meta.dirname, "contracts", "benchmark.compact");
writeFileSync(outPath, compact);

const maxHashes = targets[targets.length - 1]!.hashes;
console.log(`\nWrote ${outPath}`);
console.log(`${targets.length} circuits, max ${maxHashes} hashes`);
