/**
 * Local detection script (no MCP server restart required).
 * Uses the built analyzer directly to scan a repo and print provided API endpoints.
 *
 * Usage:
 *   node GlassEnterprise/scripts/detect-provided-apis.js "/abs/path/to/repo"
 */

import { resolve } from "path";
import { scanRepositories } from "../build/scanner/treeSitterParser.js";
import { extractEntities } from "../build/scanner/astExtractor.js";

async function main() {
  const repoRoot = process.argv[2];
  if (!repoRoot) {
    console.error(
      'Usage: node scripts/detect-provided-apis.js "/abs/path/to/repo"'
    );
    process.exit(1);
  }
  const root = resolve(repoRoot);

  console.log(`[Detect] Scanning: ${root}`);
  const repoFiles = await scanRepositories([root]);
  const entities = await extractEntities(repoFiles);

  const apis = entities.filter(
    (e) => e.type === "API" && e.direction === "provided"
  );

  if (!apis.length) {
    console.log("No provided API endpoints detected.");
    process.exit(0);
  }

  console.log(`Detected ${apis.length} provided API endpoints:`);
  // Map per file
  const byFile = new Map();
  for (const a of apis) {
    const list = byFile.get(a.file) || [];
    list.push(a);
    byFile.set(a.file, list);
  }

  const sortedFiles = Array.from(byFile.keys()).sort();
  for (const file of sortedFiles) {
    console.log(`\nFile: ${file}`);
    const list = byFile.get(file);
    for (const a of list.sort((x, y) =>
      (x.path || "").localeCompare(y.path || "")
    )) {
      const method = a.method || "GET";
      const route = a.path || a.url || "";
      console.log(`  - ${method.padEnd(6)} ${route}`);
    }
  }
}

main().catch((err) => {
  console.error("Detection failed:", err?.message || err);
  process.exit(1);
});
