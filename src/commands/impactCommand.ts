import { Driver } from "neo4j-driver";
import { runQuery } from "../neo4j/connection.js";
import { relative, isAbsolute } from "path";

/**
 * Impact analysis for a file:
 * - Starts from (File {repoRoot, file})
 * - Traverses declared/contained entities
 * - Follows dependency edges (CALLS, USES_API, PROVIDES_API, QUERIES, USES_CONFIG, EMITS_ERROR)
 * - Resolves back to Files containing affected entities
 * - Returns a human-readable summary
 */
export async function runImpactAnalysis(
  driver: Driver,
  args: { file: string; repoRoot: string; depth?: number }
): Promise<string> {
  const depth = typeof args.depth === "number" ? Math.max(1, args.depth) : 3;
  const repoRoot = args.repoRoot;
  // Normalize to relative path under repoRoot if absolute
  const fileRel = isAbsolute(args.file)
    ? relative(repoRoot, args.file)
    : args.file;

  // Ensure file exists in graph
  const seed = await runQuery<{
    id: string;
    file: string;
  }>(
    driver,
    `
    MATCH (f:File {repoRoot: $repoRoot, file: $file})
    RETURN f.id as id, f.file as file
  `,
    { repoRoot, file: fileRel }
  );

  if (!seed.length) {
    return [
      "Impact Analysis",
      `- Repository: ${repoRoot}`,
      `- File: ${fileRel}`,
      "",
      "No File node found in graph. Run the 'scan' tool first to ingest this repository.",
    ].join("\n");
  }

  // Traverse out: declared/contained entities -> dependency edges -> related entities
  // Then map back to files containing/declaring them
  const results = await runQuery<any>(
    driver,
    `
    // starting file
    MATCH (f:File {repoRoot: $repoRoot, file: $file})

    // entities declared/contained by file
    OPTIONAL MATCH path1=(f)-[:DECLARES|CONTAINS*1..]->(e)

    // follow dependency-like edges to related items
    OPTIONAL MATCH path2=(e)-[:CALLS|USES_API|PROVIDES_API|QUERIES|USES_CONFIG|EMITS_ERROR*1..$depth]->(rel)

    WITH f, collect(distinct e) as entities, collect(distinct rel) as related

    WITH f, apoc.coll.toSet(entities + related) as touched

    // back to files
    OPTIONAL MATCH (touched)<-[:DECLARES|CONTAINS*1..]-(af:File)
    WITH f, touched, collect(distinct af) as affectedFiles

    // classify touched nodes
    WITH f, touched, affectedFiles,
      [x IN touched WHERE x:API AND coalesce(x.direction,'') = 'provided'] as providedApis,
      [x IN touched WHERE x:API AND coalesce(x.direction,'') = 'consumed'] as consumedApis,
      [x IN touched WHERE x:DatabaseTable] as dbTables,
      [x IN touched WHERE x:Config] as configs,
      [x IN touched WHERE x:ErrorMessage] as errors,
      [x IN touched WHERE x:Function] as functions,
      [x IN touched WHERE x:Class] as classes,
      [x IN touched WHERE x:Test] as tests

    RETURN
      [af in affectedFiles | af.file] as affectedFilePaths,
      [p in providedApis | {method: p.method, path: p.path, file: p.file}] as providedEndpoints,
      [c in consumedApis | {method: c.method, url: c.url, file: c.file}] as consumedEndpoints,
      [t in dbTables | {table: t.name}] as tables,
      [cfg in configs | cfg.name] as configKeys,
      [err in errors | {message: err.message, file: err.file}] as errorMessages,
      [fn in functions | {name: fn.name, file: fn.file}] as functionNames,
      [cl in classes | {name: cl.name, file: cl.file}] as classNames,
      [tt in tests | {name: tt.name, file: tt.file}] as testFiles
    `,
    { repoRoot, file: fileRel, depth }
  );

  if (!results.length) {
    return [
      "Impact Analysis",
      `- Repository: ${repoRoot}`,
      `- File: ${fileRel}`,
      "",
      "No impact detected.",
    ].join("\n");
  }

  const row = results[0];

  const affectedFiles = dedupe(row.affectedFilePaths || []);
  const provided = row.providedEndpoints || [];
  const consumed = row.consumedEndpoints || [];
  const tables = dedupe((row.tables || []).map((t: any) => t.table));
  const configs = dedupe(row.configKeys || []);
  const errors = row.errorMessages || [];
  const testFiles = dedupe((row.testFiles || []).map((t: any) => t.file));
  const functions = row.functionNames || [];
  const classes = row.classNames || [];

  const lines: string[] = [];
  lines.push("Impact Analysis");
  lines.push(`- Repository: ${repoRoot}`);
  lines.push(`- File: ${fileRel}`);
  lines.push(`- Depth: ${depth}`);
  lines.push("");

  lines.push(`Affected files (${affectedFiles.length}):`);
  for (const f of affectedFiles.slice(0, 50)) {
    lines.push(`  - ${f}`);
  }
  if (affectedFiles.length > 50)
    lines.push(`  ...and ${affectedFiles.length - 50} more`);

  lines.push("");
  lines.push(`Provided APIs (${provided.length}):`);
  for (const p of provided.slice(0, 50)) {
    const method = (p.method || "").toUpperCase();
    lines.push(`  - ${method} ${p.path}  [${p.file}]`);
  }

  lines.push("");
  lines.push(`Consumed APIs (${consumed.length}):`);
  for (const c of consumed.slice(0, 50)) {
    const method = (c.method || "GET").toUpperCase();
    lines.push(`  - ${method} ${c.url}  [${c.file}]`);
  }

  lines.push("");
  lines.push(`Database tables (${tables.length}):`);
  for (const t of tables.slice(0, 50)) {
    lines.push(`  - ${t}`);
  }

  lines.push("");
  lines.push(`Configs used (${configs.length}):`);
  for (const k of configs.slice(0, 50)) {
    lines.push(`  - ${k}`);
  }

  lines.push("");
  lines.push(`Errors emitted (${errors.length}):`);
  for (const e of (errors as any[]).slice(0, 50)) {
    lines.push(`  - ${e.message}  [${e.file}]`);
  }

  lines.push("");
  lines.push(`Functions touched (${functions.length}):`);
  for (const fn of (functions as any[]).slice(0, 50)) {
    lines.push(`  - ${fn.name}  [${fn.file}]`);
  }

  lines.push("");
  lines.push(`Classes touched (${classes.length}):`);
  for (const cl of (classes as any[]).slice(0, 50)) {
    lines.push(`  - ${cl.name}  [${cl.file}]`);
  }

  lines.push("");
  lines.push(`Tests related (${testFiles.length}):`);
  for (const tf of testFiles.slice(0, 50)) {
    lines.push(`  - ${tf}`);
  }

  return lines.join("\n");
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
