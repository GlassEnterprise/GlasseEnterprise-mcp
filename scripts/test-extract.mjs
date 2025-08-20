import { resolve } from "path";
import process from "node:process";

import { scanRepositories } from "../build/scanner/treeSitterParser.js";
import { extractEntities } from "../build/scanner/astExtractor.js";

async function main() {
  // Set verbose logging to stderr to observe any AST warnings
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || "debug";

  const repoRoot = resolve(".");
  console.log(`[TestExtract] repoRoot=${repoRoot}`);

  // Limit scope to TypeScript files in src to keep test fast
  const repoFiles = await scanRepositories([repoRoot], {
    includeGlobs: ["src/**/*.ts"],
    excludeGlobs: ["build/**", "node_modules/**"],
  });

  const totalFiles = repoFiles.reduce((s, r) => s + r.files.length, 0);
  console.log(`[TestExtract] files scanned=${totalFiles}`);

  const entities = await extractEntities(repoFiles);
  console.log(`[TestExtract] entities=${entities.length}`);

  const errorMessages = entities.filter((e) => e.type === "ErrorMessage");
  console.log(`[TestExtract] errorMessages=${errorMessages.length}`);
  if (errorMessages.length) {
    console.log(
      `[TestExtract] First error: ${errorMessages[0].message} @ ${errorMessages[0].file}:${errorMessages[0].span?.startLine}`
    );
  }

  const sampleFns = entities
    .filter((e) => e.type === "Function")
    .slice(0, 10)
    .map(
      (e) =>
        `${e.name} [${e.file}:${e.span?.startLine ?? "?"}-${
          e.span?.endLine ?? "?"
        }]`
    );
  console.log(`[TestExtract] sampleFunctions=\n${sampleFns.join("\n")}`);
}

main().catch((err) => {
  console.error("TestExtract failed:", err?.message || err);
  process.exit(1);
});
