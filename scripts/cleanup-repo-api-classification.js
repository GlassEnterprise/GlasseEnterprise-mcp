/**
 * Cleanup stale repository-level API classification in Neo4j.
 * - Deletes REPO_PROVIDES_API relationships for a given repository
 * - Optionally deletes provided API entities for that repository (always enabled here)
 *
 * Usage:
 *   node mcp-code-relationship-navigator/scripts/cleanup-repo-api-classification.js "/abs/path/to/repo"
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config as dotenv } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root
dotenv({ path: resolve(__dirname, "../.env") });

import { getDriver, runQuery, closeDriver } from "../build/neo4j/connection.js";

function toNum(x) {
  // Convert Neo4j Integer or primitive to number
  if (x == null) return 0;
  if (typeof x === "object" && typeof x.toNumber === "function") {
    try {
      return x.toNumber();
    } catch {
      return Number(x.low ?? 0);
    }
  }
  if (typeof x === "object" && "low" in x) return Number(x.low || 0);
  return Number(x);
}

async function main() {
  const repoArg = process.argv[2];
  if (!repoArg) {
    console.error(
      'Usage: node scripts/cleanup-repo-api-classification.js "/abs/path/to/repo"'
    );
    process.exit(1);
  }
  const repoRoot = resolve(repoArg);
  console.log(`[Cleanup] Target repository: ${repoRoot}`);

  const driver = await getDriver({
    uri: process.env.NEO4J_URI || "bolt://localhost:7687",
    username: process.env.NEO4J_USERNAME || "neo4j",
    password: process.env.NEO4J_PASSWORD || "password",
    database: process.env.NEO4J_DATABASE || "neo4j",
  });

  try {
    console.log("\n[Before] Relationship counts for repository:");
    const beforeProvides = await runQuery(
      driver,
      "MATCH (r:Repository {repoRoot: $repoRoot})-[rel:REPO_PROVIDES_API]->(:API) RETURN count(rel) as c",
      { repoRoot }
    );
    const beforeUses = await runQuery(
      driver,
      "MATCH (r:Repository {repoRoot: $repoRoot})-[rel:REPO_USES_API]->(:API) RETURN count(rel) as c",
      { repoRoot }
    );
    console.log(
      `REPO_PROVIDES_API: ${toNum(
        beforeProvides?.[0]?.c
      )} | REPO_USES_API: ${toNum(beforeUses?.[0]?.c)}`
    );

    console.log("\n[Delete] Removing REPO_PROVIDES_API relationships...");
    const delProvides = await runQuery(
      driver,
      "MATCH (r:Repository {repoRoot: $repoRoot})-[rel:REPO_PROVIDES_API]->() DELETE rel RETURN count(rel) as deleted",
      { repoRoot }
    );
    console.log(
      `Deleted REPO_PROVIDES_API relationships: ${toNum(
        delProvides?.[0]?.deleted
      )}`
    );

    console.log(
      "\n[Delete] Removing provided API entities for this repository..."
    );
    const delProvidedApiEntities = await runQuery(
      driver,
      "MATCH (a:API {repoRoot: $repoRoot, direction: 'provided'}) DETACH DELETE a RETURN count(a) as deletedApis",
      { repoRoot }
    );
    console.log(
      `Deleted provided API entities: ${toNum(
        delProvidedApiEntities?.[0]?.deletedApis
      )}`
    );

    console.log("\n[After] Relationship counts for repository:");
    const afterProvides = await runQuery(
      driver,
      "MATCH (r:Repository {repoRoot: $repoRoot})-[rel:REPO_PROVIDES_API]->(:API) RETURN count(rel) as c",
      { repoRoot }
    );
    const afterUses = await runQuery(
      driver,
      "MATCH (r:Repository {repoRoot: $repoRoot})-[rel:REPO_USES_API]->(:API) RETURN count(rel) as c",
      { repoRoot }
    );
    console.log(
      `REPO_PROVIDES_API: ${toNum(
        afterProvides?.[0]?.c
      )} | REPO_USES_API: ${toNum(afterUses?.[0]?.c)}`
    );

    console.log("\n[Cleanup] Completed.");
  } catch (err) {
    console.error("Cleanup failed:", err?.message || err);
    process.exit(1);
  } finally {
    await closeDriver();
  }
}

main().catch((e) => {
  console.error("Cleanup failed:", e?.message || e);
  process.exit(1);
});
