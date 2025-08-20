import { Driver } from "neo4j-driver";

/**
 * Learn command: Onboarding walkthrough of the repository graph.
 * Explains:
 *  - What nodes and relationships exist
 *  - How to run core queries
 *  - Quick checks to validate ingestion
 */
export async function runLearn(_driver: Driver): Promise<string> {
  const lines: string[] = [];

  lines.push("MCP Code Relationship Navigator — Learn");
  lines.push("");
  lines.push("What this graph contains");
  lines.push("- Repository → Files → Classes/Functions/Variables");
  lines.push("- APIs (provided and consumed) via simple heuristics");
  lines.push("- Config keys used in code (e.g., process.env.XYZ, os.getenv)");
  lines.push("- Database tables (basic heuristics; extend for SQL parsing)");
  lines.push("- Test files and basic framework detection");
  lines.push("- Error messages emitted (throw new Error, logger.error)");
  lines.push("");
  lines.push("Node labels");
  lines.push("- Repository (reserved for future ingestion expansion)");
  lines.push("- File");
  lines.push("- Class");
  lines.push("- Function");
  lines.push("- Variable");
  lines.push("- API (direction: provided | consumed)");
  lines.push("- DatabaseTable");
  lines.push("- DatabaseColumn (planned extension)");
  lines.push("- Config");
  lines.push("- Test");
  lines.push("- ErrorMessage");
  lines.push("");
  lines.push("Relationship types");
  lines.push("- CONTAINS: File → any entity it contains");
  lines.push("- DECLARES: File → Class|Function|Variable declared in it");
  lines.push("- HAS_FUNCTION: Class → Function (span within class)");
  lines.push("- CALLS: Function → Function");
  lines.push("- PROVIDES_API: Function → API(direction='provided')");
  lines.push("- USES_API: Function → API(direction='consumed')");
  lines.push("- QUERIES: Function → DatabaseTable");
  lines.push("- USES_CONFIG: Function → Config");
  lines.push("- EMITS_ERROR: Function → ErrorMessage (line within span)");
  lines.push("");
  lines.push("Core MCP tools");
  lines.push(
    "- scan: Parse repositories with Tree-sitter, store nodes/relationships. Supports `watch` for incremental updates."
  );
  lines.push(
    "- impact --file path/to/file: Show affected files/APIs/tables/tests via dependency traversal."
  );
  lines.push(
    '- query "natural language": Convert to Cypher; or pass raw Cypher with `CYPHER:`.'
  );
  lines.push("- learn: This guide.");
  lines.push("");
  lines.push("Quick validation queries (use the `query` tool with CYPHER:)");
  lines.push("1) Count by label");
  lines.push(`CYPHER:
MATCH (n)
WITH labels(n) AS labs
UNWIND labs AS l
RETURN l AS label, count(*) AS cnt
ORDER BY cnt DESC`);
  lines.push("");
  lines.push("2) Recent APIs detected");
  lines.push(`CYPHER:
MATCH (a:API)
RETURN a.direction AS dir, coalesce(a.method,'GET') AS method, coalesce(a.path, a.url) AS route, a.file AS file
LIMIT 25`);
  lines.push("");
  lines.push("3) Function call edges");
  lines.push(`CYPHER:
MATCH (a:Function)-[:CALLS]->(b:Function)
RETURN a.name AS caller, b.name AS callee
LIMIT 25`);
  lines.push("");
  lines.push("4) Config usage by file");
  lines.push(`CYPHER:
MATCH (f:File)-[:DECLARES|CONTAINS*1..]->(fn:Function)-[:USES_CONFIG]->(c:Config)
RETURN f.file AS file, collect(distinct c.name) AS keys
ORDER BY file
LIMIT 50`);
  lines.push("");
  lines.push("5) Impact surface for a file (manual)");
  lines.push(`CYPHER:
MATCH (f:File {file: "src/example.ts"})
OPTIONAL MATCH (f)-[:DECLARES|CONTAINS*1..]->(e)
OPTIONAL MATCH (e)-[:CALLS|USES_API|PROVIDES_API|QUERIES|USES_CONFIG|EMITS_ERROR*1..3]->(rel)
WITH collect(distinct e) + collect(distinct rel) AS touched
UNWIND touched AS t
MATCH (af:File)-[:DECLARES|CONTAINS*1..]->(t)
RETURN distinct af.file
LIMIT 100`);
  lines.push("");
  lines.push("Advanced analyses");
  lines.push("");
  lines.push("A) Circular function-call dependencies (optional path scope)");
  lines.push(`CYPHER:
MATCH p=(a:Function)-[:CALLS*1..8]->(a)
WITH p, nodes(p) AS fns
UNWIND fns AS fn
OPTIONAL MATCH (f:File)-[:DECLARES|CONTAINS*1..]->(fn)
WITH p, collect(distinct fn.name) AS functions, collect(distinct f.file) AS files
RETURN size(nodes(p)) AS cycleLength, functions, files
ORDER BY cycleLength DESC
LIMIT 25`);
  lines.push("");
  lines.push("B) Repository-level API consumption cycles");
  lines.push(`CYPHER:
MATCH p=(r:Repository)-[:CONSUMES_API_FROM*1..5]->(r)
RETURN [x IN nodes(p) | coalesce(x.name, x.repoRoot)] AS repositories, length(p) AS hops
ORDER BY hops DESC
LIMIT 25`);
  lines.push("");
  lines.push("C) Impact of API response change for endpoint '/api/test'");
  lines.push(`CYPHER:
MATCH (prov:API {direction:"provided"})
WHERE toLower(coalesce(prov.path,"")) CONTAINS toLower("/api/test")
OPTIONAL MATCH (pf:Function)-[:PROVIDES_API]->(prov)
OPTIONAL MATCH (pfile:File)-[:DECLARES|CONTAINS*1..]->(pf)
WITH prov, pf, pfile
OPTIONAL MATCH (caller:Function)-[:CALLS*1..3]->(pf)
OPTIONAL MATCH (cfile:File)-[:DECLARES|CONTAINS*1..]->(caller)
WITH prov, pfile, collect(distinct cfile.file) AS internalFiles
OPTIONAL MATCH (consumed:API {direction:"consumed"})
WHERE toLower(coalesce(consumed.url,"")) CONTAINS toLower(coalesce(prov.path,""))
OPTIONAL MATCH (cf:Function)-[:USES_API]->(consumed)
OPTIONAL MATCH (cffile:File)-[:DECLARES|CONTAINS*1..]->(cf)
RETURN coalesce(prov.method,"GET") AS method,
       coalesce(prov.path, prov.url) AS route,
       pfile.repoRoot AS providerRepo,
       pfile.file AS providerFile,
       internalFiles AS internalAffectedFiles,
       collect(distinct cffile.repoRoot) AS consumerRepos,
       collect(distinct cffile.file) AS consumerFiles
LIMIT 25`);
  lines.push("");
  lines.push("Tips");
  lines.push(
    "- For large repositories, run scan without watch first, then enable watch."
  );
  lines.push(
    "- Extend language coverage by adding more Tree-sitter grammars and language-specific analyzers."
  );
  lines.push(
    "- For ambiguous API detection, add small AI classification hooks on code snippets (planned extension)."
  );
  lines.push(
    "- If you don't see results, ensure your Neo4j credentials in .env and that APOC is enabled for merge utilities (or adjust queries to pure MERGE)."
  );
  lines.push("");
  lines.push("Next steps");
  lines.push('- Run: scan (optionally with { paths: ["."], watch: true })');
  lines.push("- Explore: query \"list provided apis in path 'src'\"");
  lines.push("- Analyze: impact --file path/to/changed/file");

  return lines.join("\n");
}
