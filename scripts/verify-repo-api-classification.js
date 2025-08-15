/**
 * Verify repository-level API classification.
 * Scans a repo, extracts entities, builds relationships, and prints:
 * - Count of provided vs consumed API entities
 * - REPO_PROVIDES_API and REPO_USES_API relationships for the repo
 *
 * Usage:
 *   node GlassEnterprise/scripts/verify-repo-api-classification.js "/abs/path/to/repo"
 */

import { resolve } from "path";
import { scanRepositories } from "../build/scanner/treeSitterParser.js";
import { extractEntities } from "../build/scanner/astExtractor.js";
import { buildRelationships } from "../build/scanner/relationshipBuilder.js";

async function main() {
  const repoRootArg = process.argv[2];
  if (!repoRootArg) {
    console.error(
      'Usage: node scripts/verify-repo-api-classification.js "/abs/path/to/repo"'
    );
    process.exit(1);
  }
  const repoRoot = resolve(repoRootArg);

  console.log(`[Verify] Scanning: ${repoRoot}`);
  const repoFiles = await scanRepositories([repoRoot]);
  const entities = await extractEntities(repoFiles);
  const relationships = buildRelationships(entities);

  const apis = entities.filter((e) => e.type === "API");
  const providedAPIs = apis.filter((e) => e.direction === "provided");
  const consumedAPIs = apis.filter((e) => e.direction === "consumed");

  console.log("\n=== API ENTITY SUMMARY ===");
  console.log(`Provided API entities: ${providedAPIs.length}`);
  console.log(`Consumed API entities: ${consumedAPIs.length}`);

  const repoEntity = entities.find(
    (e) => e.type === "Repository" && e.repoRoot === repoRoot
  );
  if (!repoEntity) {
    console.error("Repository entity not found for root:", repoRoot);
    process.exit(2);
  }

  const providesRels = relationships.filter(
    (r) => r.type === "REPO_PROVIDES_API" && r.fromId === repoEntity.id
  );
  const usesRels = relationships.filter(
    (r) => r.type === "REPO_USES_API" && r.fromId === repoEntity.id
  );

  console.log("\n=== REPOSITORY-LEVEL RELATIONSHIPS ===");
  console.log(`REPO_PROVIDES_API: ${providesRels.length}`);
  console.log(`REPO_USES_API:     ${usesRels.length}`);

  // Print a few samples for each type
  const apiById = new Map(apis.map((a) => [a.id, a]));
  function printRelSample(label, rels, limit = 5) {
    if (!rels.length) return;
    console.log(`\n${label} sample (max ${limit}):`);
    for (const r of rels.slice(0, limit)) {
      const api = apiById.get(r.toId);
      if (!api) continue;
      const dir = api.direction;
      const method = api.method || "GET";
      const route = api.path || api.url || "";
      console.log(
        `- ${dir?.toUpperCase()} ${method} ${route} (API id: ${api.id})`
      );
    }
  }

  printRelSample("REPO_PROVIDES_API", providesRels);
  printRelSample("REPO_USES_API", usesRels);

  // Classification assertion summary
  console.log("\n=== CLASSIFICATION CHECK ===");
  if (usesRels.length > 0 && providesRels.length === 0) {
    console.log(
      "Result: ✅ Repository classified as API consumer (no provided APIs detected)."
    );
  } else if (providesRels.length > 0 && usesRels.length === 0) {
    console.log(
      "Result: ✅ Repository classified as API provider (no consumed APIs detected)."
    );
  } else if (providesRels.length > 0 && usesRels.length > 0) {
    console.log("Result: ℹ️ Repository both provides and consumes APIs.");
  } else {
    console.log("Result: ℹ️ No API usage or provision detected.");
  }
}

main().catch((err) => {
  console.error("Verification failed:", err?.message || err);
  process.exit(1);
});
