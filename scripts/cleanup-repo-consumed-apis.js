/**
 * Cleanup stale repository-level consumed API classification in Neo4j.
 * - Deletes REPO_USES_API relationships for a given repository
 * - Deletes consumed API entities (direction: 'consumed') for that repository
 *
 * Usage:
 *   node GlassEnterprise/scripts/cleanup-repo-consumed-apis.js "/abs/path/to/repo"
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
      'Usage: node scripts/cleanup-repo-consumed-apis.js "/abs/path/to/repo"'
    );
    process.exit(1);
  }
  const repoRoot = resolve(repoArg);
  console.log(`[Cleanup Consumed APIs] Target repository: ${repoRoot}`);

  const driver = await getDriver({
    uri: process.env.NEO4J_URI || "bolt://localhost:7687",
    username: process.env.NEO4J_USERNAME || "neo4j",
    password: process.env.NEO4J_PASSWORD || "password",
    database: process.env.NEO4J_DATABASE || "neo4j",
  });

  try {
    console.log("\n[Before] Relationship & API counts for repository:");
    const beforeUses = await runQuery(
      driver,
      "MATCH (r:Repository {repoRoot: $repoRoot})-[rel:REPO_USES_API]->(:API) RETURN count(rel) as c",
      { repoRoot }
    );
    const beforeConsumedApis = await runQuery(
      driver,
      "MATCH (a:API {repoRoot: $repoRoot, direction: 'consumed'}) RETURN count(a) as c",
      { repoRoot }
    );
    console.log(
      `REPO_USES_API: ${toNum(
        beforeUses?.[0]?.c
      )} | Consumed API nodes: ${toNum(beforeConsumedApis?.[0]?.c)}`
    );

    console.log("\n[Delete] Removing REPO_USES_API relationships...");
    const delUses = await runQuery(
      driver,
      "MATCH (r:Repository {repoRoot: $repoRoot})-[rel:REPO_USES_API]->() DELETE rel RETURN count(rel) as deleted",
      { repoRoot }
    );
    console.log(
      `Deleted REPO_USES_API relationships: ${toNum(delUses?.[0]?.deleted)}`
    );

    console.log(
      "\n[Delete] Removing consumed API entities for this repository..."
    );
    const delConsumedApiEntities = await runQuery(
      driver,
      "MATCH (a:API {repoRoot: $repoRoot, direction: 'consumed'}) DETACH DELETE a RETURN count(a) as deletedApis",
      { repoRoot }
    );
    console.log(
      `Deleted consumed API entities: ${toNum(
        delConsumedApiEntities?.[0]?.deletedApis
      )}`
    );

    console.log("\n[After] Relationship & API counts for repository:");
    const afterUses = await runQuery(
      driver,
      "MATCH (r:Repository {repoRoot: $repoRoot})-[rel:REPO_USES_API]->(:API) RETURN count(rel) as c",
      { repoRoot }
    );
    const afterConsumedApis = await runQuery(
      driver,
      "MATCH (a:API {repoRoot: $repoRoot, direction: 'consumed'}) RETURN count(a) as c",
      { repoRoot }
    );
    console.log(
      `REPO_USES_API: ${toNum(afterUses?.[0]?.c)} | Consumed API nodes: ${toNum(
        afterConsumedApis?.[0]?.c
      )}`
    );

    console.log("\n[Cleanup Consumed APIs] Completed.");
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
