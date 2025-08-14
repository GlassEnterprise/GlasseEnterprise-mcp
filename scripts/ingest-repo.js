/**
 * Ingest a repository into Neo4j using the latest local build without restarting the MCP server.
 *
 * Usage:
 *   node mcp-code-relationship-navigator/scripts/ingest-repo.js "/abs/path/to/repo"
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
import { getDriver } from "../build/neo4j/connection.js";
import { upsertEntitiesBatch } from "../build/neo4j/saveNodes.js";
import { upsertRelationshipsBatch } from "../build/neo4j/saveRelationships.js";
import { extractDependencies } from "../build/scanner/dependencyExtractor.js";

async function main() {
  const repoRoot = process.argv[2];
  if (!repoRoot) {
    console.error('Usage: node scripts/ingest-repo.js "/abs/path/to/repo"');
    process.exit(1);
  }
  const root = resolve(repoRoot);
  console.log(`[Ingest] Scanning & ingesting: ${root}`);

  // 1) Scan files
  const repoFiles = await scanRepositories([root]);

  // 2) Extract entities with latest local analyzer (+ package/dependency entities)
  const entities = await extractEntities(repoFiles);
  const depEntities = await extractDependencies([root]);
  const allEntities = [...entities, ...depEntities];

  // 3) Build relationships
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

  // Summaries
  const providedApis = allEntities.filter(
    (e) => e.type === "API" && e.direction === "provided"
  );
  console.log(
    `[Ingest] Done. Entities=${entities.length} Relationships=${relationships.length} ProvidedAPIs=${providedApis.length}`
  );

  if (providedApis.length) {
    // quick peek
    const byFile = new Map();
    for (const a of providedApis) {
      const list = byFile.get(a.file) || [];
      list.push(a);
      byFile.set(a.file, list);
    }
    const files = Array.from(byFile.keys()).sort();
    for (const f of files) {
      console.log(`\nFile: ${f}`);
      for (const a of byFile
        .get(f)
        .sort((x, y) => (x.path || "").localeCompare(y.path || ""))) {
        console.log(`  - ${(a.method || "GET").padEnd(6)} ${a.path || ""}`);
      }
    }
  }
}

main().catch((err) => {
  console.error("Ingest failed:", err?.message || err);
  process.exit(1);
});
