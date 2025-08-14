import chokidar from "chokidar";
import { join, resolve, relative } from "path";
import { readFile } from "fs/promises";
import { RepoFiles, FileInfo, LanguageId } from "./types.js";
import { Logger } from "../utils/logger.js";
import { detectLanguageByExt } from "./treeSitterParser.js";

const logger = new Logger("IncrementalWatcher");

/**
 * Start chokidar watchers for one or more roots. On changes, build a minimal RepoFiles[]
 * payload containing only changed files and pass to the callback.
 */
export function startIncrementalWatcher(
  roots: string[],
  includeGlobs: string[],
  excludeGlobs: string[],
  onDelta: (delta: RepoFiles[]) => Promise<void> | void
): void {
  const watchers: chokidar.FSWatcher[] = [];
  for (const root of roots) {
    const absRoot = resolve(root);

    const watcher = chokidar.watch(
      includeGlobs.length ? includeGlobs : ["**/*"],
      {
        cwd: absRoot,
        ignored: excludeGlobs,
        ignoreInitial: true,
        persistent: true,
      }
    );

    const processPaths = async (paths: string[]) => {
      // Build RepoFiles[] grouped by repoRoot
      const files: FileInfo[] = [];
      for (const relPath of paths) {
        const abs = join(absRoot, relPath);
        try {
          const content = await readFile(abs, "utf-8");
          const language: LanguageId | "unknown" = detectLanguageByExt(relPath);
          files.push({
            repoRoot: absRoot,
            relPath,
            absPath: abs,
            language,
            content,
          });
        } catch (e) {
          // File may be deleted between event and read; skip
          logger.warn(`Skipped changed file (unreadable): ${abs}`, {
            error: (e as Error)?.message,
          });
        }
      }

      if (!files.length) return;
      const delta: RepoFiles[] = [{ repoRoot: absRoot, files }];
      try {
        await onDelta(delta);
      } catch (e) {
        logger.error("onDelta callback failed", e);
      }
    };

    const changedQueue = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      if (!changedQueue.size) return;
      const batch = Array.from(changedQueue);
      changedQueue.clear();
      processPaths(batch).catch((e) => logger.error("processPaths failed", e));
    };
    const scheduleFlush = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, 300);
    };

    watcher
      .on("add", (path) => {
        changedQueue.add(path);
        scheduleFlush();
      })
      .on("change", (path) => {
        changedQueue.add(path);
        scheduleFlush();
      })
      .on("unlink", (path) => {
        // For simplicity, we currently do not delete nodes; we re-ingest current state on next change.
        // A production system should detect deletions and remove nodes/relationships accordingly.
        logger.info(`File removed: ${join(absRoot, path)}`);
      })
      .on("error", (err) => logger.error("Watcher error", err));

    watchers.push(watcher);
    logger.info(`Watching ${absRoot}`);
  }
}
