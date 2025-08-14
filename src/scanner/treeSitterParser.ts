import { glob } from "glob";
import { readFile } from "fs/promises";
import { join, resolve } from "path";
import ignore from "ignore";
import { FileInfo, RepoFiles, LanguageId } from "./types.js";
import { Logger } from "../utils/logger.js";

const logger = new Logger("TreeSitterParser");

const DEFAULT_INCLUDE = [
  "**/*.js",
  "**/*.jsx",
  "**/*.ts",
  "**/*.tsx",
  "**/*.py",
  "**/*.java",
  "**/*.cs",
];

const DEFAULT_EXCLUDE = [
  "node_modules/**",
  ".git/**",
  "build/**",
  "dist/**",
  "out/**",
  "bin/**",
  "obj/**",
  "target/**",
  "**/*.min.*",
  "**/*.map",
  "**/.DS_Store",
  ".idea/**",
  ".vscode/**",
];

export function detectLanguageByExt(path: string): LanguageId | "unknown" {
  const lower = path.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".cs")) return "csharp";
  return "unknown";
}

/**
 * Scan one or more repository roots and return files with basic metadata and content.
 * The AST parsing is handled in astExtractor.ts
 */
export async function scanRepositories(
  roots: string[],
  opts?: {
    includeGlobs?: string[];
    excludeGlobs?: string[];
  }
): Promise<RepoFiles[]> {
  const includeGlobs = opts?.includeGlobs?.length
    ? opts.includeGlobs
    : DEFAULT_INCLUDE;
  const excludeGlobs = opts?.excludeGlobs?.length
    ? opts.excludeGlobs
    : DEFAULT_EXCLUDE;

  const results: RepoFiles[] = [];

  for (const root of roots) {
    const repoRoot = resolve(root);
    const files = await glob(includeGlobs, {
      cwd: repoRoot,
      ignore: excludeGlobs,
      nodir: true,
      withFileTypes: false,
    });

    logger.info(`[SCAN] Found ${files.length} files in ${repoRoot}`);
    if (files.length === 0) {
      logger.warn(
        `[SCAN] No files matched includeGlobs in ${repoRoot}: ${JSON.stringify(
          includeGlobs
        )}`
      );
    }

    // Allow .gitignore rules from repo root if present (best-effort)
    const ig = (ignore as unknown as (options?: any) => any)();
    try {
      const gi = await readFile(join(repoRoot, ".gitignore"), "utf-8");
      ig.add(gi.split("\n"));
      logger.info(`[SCAN] Loaded .gitignore from ${repoRoot}`);
    } catch (err) {
      logger.info(`[SCAN] No .gitignore found in ${repoRoot}`);
    }

    const fileInfos: FileInfo[] = [];
    let skippedByGitignore = 0;
    let failedToRead = 0;
    for (const relPath of files) {
      if (ig.ignores(relPath)) {
        logger.info(`[SCAN] Skipped by .gitignore: ${relPath}`);
        skippedByGitignore++;
        continue;
      }

      const absPath = join(repoRoot, relPath);
      try {
        const content = await readFile(absPath, "utf-8");
        const language = detectLanguageByExt(relPath);
        fileInfos.push({ repoRoot, relPath, absPath, language, content });
        logger.info(`[SCAN] Read file: ${absPath} (language: ${language})`);
      } catch (e) {
        logger.error(`[SCAN] Failed to read file: ${absPath}`, {
          error: (e as Error)?.message,
        });
        failedToRead++;
      }
    }

    logger.info(
      `[SCAN] Summary for ${repoRoot}: total=${files.length}, skippedByGitignore=${skippedByGitignore}, failedToRead=${failedToRead}, processed=${fileInfos.length}`
    );

    results.push({ repoRoot, files: fileInfos });
  }

  logger.info(
    `Scanned ${results.length} repositories; total files: ${results.reduce(
      (s, r) => s + r.files.length,
      0
    )}`
  );

  return results;
}
