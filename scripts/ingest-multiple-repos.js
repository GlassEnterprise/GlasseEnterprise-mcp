/**
 * Ingest multiple repositories into Neo4j in a single pass to enable cross-repository linking.
 *
 * Usage:
 *   node mcp-code-relationship-navigator/scripts/ingest-multiple-repos.js "/abs/path/to/repoA" "/abs/path/to/repoB" [more...]
 *
 * Notes:
 * - This script scans all provided roots together so CONSUMES_API_FROM and SHARES_PACKAGE_WITH can be created.
 * - Requires Neo4j credentials in mcp-code-relationship-navigator/.env or environment variables.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config as dotenv } from "dotenv";

// Resolve __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root (../.env relative to scripts/)
dotenv({ path: resolve(__dirname, "../.env") });

import { scanRepositories } from "../build/scanner/treeSitterParser.js";
import { extractEntities } from "../build/scanner/astExtractor.js";
import { buildRelationships } from "../build/scanner/relationshipBuilder.js";
import { extractDependencies } from "../build/scanner/dependencyExtractor.js";
import { getDriver } from "../build/neo4j/connection.js";
import { upsertEntitiesBatch } from "../build/neo4j/saveNodes.js";
import { upsertRelationshipsBatch } from "../build/neo4j/saveRelationships.js";

function relCount(relationships, type) {
  return relationships.filter((r) => r.type === type).length;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error(
      'Usage: node scripts/ingest-multiple-repos.js "/abs/path/to/repoA" "/abs/path/to/repoB" [...]'
    );
    process.exit(1);
  }
  const roots = args.map((p) => resolve(p));
  console.log(`[Ingest-Multi] Roots:`);
  for (const r of roots) console.log(`  - ${r}`);

  // 1) Scan all roots together
  const repoFiles = await scanRepositories(roots);

  // 2) Extract entities (code) + dependencies (packages)
  const entities = await extractEntities(repoFiles);
  const depEntities = await extractDependencies(roots);
  const allEntities = [...entities, ...depEntities];

  // 3) Build relationships (within and across repos)
  const relationships = buildRelationships(allEntities);

  // 4) Persist to Neo4j
  const driver = await getDriver({
    uri: process.env.NEO4J_URI || "bolt://localhost:7687",
    username: process.env.NEO4J_USERNAME || "neo4j",
    password: process.env.NEO4J_PASSWORD || "password",
    database: process.env.NEO4J_DATABASE || "neo4j",
  });

  await upsertEntitiesBatch(driver, allEntities);
  await upsertRelationshipsBatch(driver, relationships);

  // 5) Summaries
  const providedApis = allEntities.filter(
    (e) => e.type === "API" && e.direction === "provided"
  );
  const consumedApis = allEntities.filter(
    (e) => e.type === "API" && e.direction === "consumed"
  );
  const pkgEntities = allEntities.filter((e) => e.type === "Package");

  console.log(`\n[Ingest-Multi] Done.`);
  console.log(
    `Entities=${allEntities.length} (ProvidedAPIs=${providedApis.length}, ConsumedAPIs=${consumedApis.length}, Packages=${pkgEntities.length})`
  );
  console.log(
    `Relationships=${relationships.length} ` +
      `(REPO_PROVIDES_API=${relCount(relationships, "REPO_PROVIDES_API")}, ` +
      `REPO_USES_API=${relCount(relationships, "REPO_USES_API")}, ` +
      `CONSUMES_API_FROM=${relCount(relationships, "CONSUMES_API_FROM")}, ` +
      `REPO_DEPENDS_ON_PACKAGE=${relCount(
        relationships,
        "REPO_DEPENDS_ON_PACKAGE"
      )}, ` +
      `SHARES_PACKAGE_WITH=${relCount(relationships, "SHARES_PACKAGE_WITH")})`
  );
}

main().catch((err) => {
  console.error("Ingest-Multiple failed:", err?.message || err);
  process.exit(1);
});
