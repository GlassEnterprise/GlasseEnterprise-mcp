import { Driver } from "neo4j-driver";
import { runQuery } from "../neo4j/connection.js";

/**
 * Natural language → Cypher conversion with simple heuristics.
 * Also supports raw Cypher when prompt starts with "CYPHER:".
 */
export async function runNaturalLanguageQuery(
  driver: Driver,
  args: { prompt: string; limit?: number }
): Promise<string> {
  const prompt = (args.prompt || "").trim();
  const limit = Number.isFinite(args.limit as number)
    ? Math.max(0, Math.floor(args.limit as number))
    : 100;

  // Raw Cypher passthrough
  if (/^\s*CYPHER\s*:/i.test(prompt)) {
    const cypher = prompt.replace(/^\s*CYPHER\s*:/i, "").trim();
    const rows = await runQuery<any>(
      driver,
      `${cypher} LIMIT toInteger($limit)`,
      { limit }
    );
    return formatResult(cypher, rows);
  }

  // Advanced heuristic templates
  const advancedTemplates: {
    match: RegExp;
    cypher: (m: RegExpExecArray) => string;
  }[] = [
    {
      // A1) Circular function-call dependencies (optionally scoped by path/repo)
      match:
        /(circular|cycle|cyclic).*(function|call|dependency)(?:.*["'`](.+?)["'`])?/i,
      cypher: (m) => {
        const scope = m[3] ? escapeForCypher(m[3]) : null;
        const scopeWhere = scope
          ? `WHERE ANY(x IN files WHERE toLower(coalesce(x,"")) CONTAINS toLower("${scope}"))`
          : "";
        return `
          MATCH p=(a:Function)-[:CALLS*1..8]->(a)
          WITH p, nodes(p) AS fns
          UNWIND fns AS fn
          OPTIONAL MATCH (f:File)-[:DECLARES|CONTAINS*1..]->(fn)
          WITH p, collect(distinct fn.name) AS functions, collect(distinct f.file) AS files
          ${scopeWhere}
          RETURN size(nodes(p)) AS cycleLength, functions, files
          ORDER BY cycleLength DESC
        `;
      },
    },
    {
      // A2) Repository-level API consumption cycles
      match: /(circular|cycle|cyclic).*(api).*(repo|repository)/i,
      cypher: () => `
        MATCH p=(r:Repository)-[:CONSUMES_API_FROM*1..5]->(r)
        RETURN [x IN nodes(p) | coalesce(x.name, x.repoRoot)] AS repositories, length(p) AS hops
        ORDER BY hops DESC
      `,
    },
    {
      // A3) Impact of API response change for specified endpoint
      match:
        /(impact|affected|affect).*(api|endpoint).*(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)?[^"'`]*["'`](.+?)["'`]/i,
      cypher: (m) => {
        const method = (m[3] || "").toUpperCase();
        const endpoint = escapeForCypher(m[4] || "");
        const methodClauseProvided = method
          ? `AND toUpper(coalesce(prov.method,"GET")) = "${method}"`
          : "";
        const methodClauseConsumed = method
          ? `AND toUpper(coalesce(consumed.method,"GET")) = "${method}"`
          : `AND toUpper(coalesce(consumed.method,"GET")) = toUpper(coalesce(prov.method,"GET"))`;
        return `
          MATCH (prov:API {direction:"provided"})
          WHERE toLower(coalesce(prov.path,"")) CONTAINS toLower("${endpoint}")
          ${methodClauseProvided}
          OPTIONAL MATCH (pf:Function)-[:PROVIDES_API]->(prov)
          OPTIONAL MATCH (pfile:File)-[:DECLARES|CONTAINS*1..]->(pf)
          WITH prov, pf, pfile
          OPTIONAL MATCH (caller:Function)-[:CALLS*1..3]->(pf)
          OPTIONAL MATCH (cfile:File)-[:DECLARES|CONTAINS*1..]->(caller)
          WITH prov, pfile, collect(distinct cfile.file) AS internalFiles
          OPTIONAL MATCH (consumed:API {direction:"consumed"})
          WHERE toLower(coalesce(consumed.url,"")) CONTAINS toLower(coalesce(prov.path,""))
          ${methodClauseConsumed}
          OPTIONAL MATCH (cf:Function)-[:USES_API]->(consumed)
          OPTIONAL MATCH (cffile:File)-[:DECLARES|CONTAINS*1..]->(cf)
          RETURN coalesce(prov.method,"GET") AS method,
                 coalesce(prov.path, prov.url) AS route,
                 pfile.repoRoot AS providerRepo,
                 pfile.file AS providerFile,
                 internalFiles AS internalAffectedFiles,
                 collect(distinct cffile.repoRoot) AS consumerRepos,
                 collect(distinct cffile.file) AS consumerFiles
        `;
      },
    },
  ];

  // Heuristic templates
  const templates: { match: RegExp; cypher: (m: RegExpExecArray) => string }[] =
    [
      // 1) Impact of a file change
      {
        match:
          /(affected|impact).*(files|apis|tables|tests).*(for|if).*(file\s+)?["'`](.+?)["'`]/i,
        cypher: (m) => {
          const file = m[5];
          return `
          MATCH (f:File {file: "${escapeForCypher(file)}"})
          OPTIONAL MATCH (f)-[:DECLARES|CONTAINS*1..]->(e)
          OPTIONAL MATCH (e)-[:CALLS|USES_API|PROVIDES_API|QUERIES|USES_CONFIG|EMITS_ERROR*1..3]->(rel)
          WITH f, collect(distinct e) + collect(distinct rel) as touched
          WITH f, apoc.coll.toSet(touched) as touched
          OPTIONAL MATCH (touched)<-[:DECLARES|CONTAINS*1..]-(af:File)
          WITH f,
               collect(distinct af.file) as affectedFiles,
               [x IN touched WHERE x:API AND coalesce(x.direction,'')='provided' | {method:x.method, path:x.path, file:x.file}] as providedApis,
               [x IN touched WHERE x:API AND coalesce(x.direction,'')='consumed' | {method:x.method, url:x.url, file:x.file}] as consumedApis,
               [x IN touched WHERE x:DatabaseTable | {table:x.name}] as tables,
               [x IN touched WHERE x:Config | x.name] as configKeys,
               [x IN touched WHERE x:ErrorMessage | {message:x.message, file:x.file}] as errors
          RETURN affectedFiles, providedApis, consumedApis, tables, configKeys, errors
        `;
        },
      },

      // 2) List provided APIs in a repository path
      {
        match:
          /(list|show).*(provided\s+apis|apis\s+provided).*?(in|for).*(repo|repository|path)\s+["'`](.+?)["'`]/i,
        cypher: (m) => {
          const path = m[6];
          return `
          MATCH (a:API {direction:"provided"})
          WHERE a.repoRoot CONTAINS "${escapeForCypher(path)}"
          RETURN a.method as method, a.path as path, a.file as file
          ORDER BY a.file, a.path
        `;
        },
      },

      // 3) List consumed APIs in a repository path
      {
        match:
          /(list|show).*(consumed\s+apis|apis\s+consumed).*?(in|for).*(repo|repository|path)\s+["'`](.+?)["'`]/i,
        cypher: (m) => {
          const path = m[6];
          return `
          MATCH (a:API {direction:"consumed"})
          WHERE a.repoRoot CONTAINS "${escapeForCypher(path)}"
          RETURN a.method as method, a.url as url, a.file as file
          ORDER BY a.file, a.url
        `;
        },
      },

      // 4) Who calls function X
      {
        match: /(who|which).*(calls|invokes).*(function)\s+["'`](.+?)["'`]/i,
        cypher: (m) => {
          const fn = m[4];
          return `
          MATCH (callee:Function {name: "${escapeForCypher(fn)}"})
          MATCH (caller:Function)-[:CALLS]->(callee)
          OPTIONAL MATCH (f:File)-[:DECLARES|CONTAINS*1..]->(caller)
          RETURN caller.name as caller, f.file as file
          ORDER BY file, caller
        `;
        },
      },

      // 5) Configs used by a file
      {
        match:
          /(what|which).*(configs|config).*(used|uses).*file\s+["'`](.+?)["'`]/i,
        cypher: (m) => {
          const file = m[4];
          return `
          MATCH (f:File {file: "${escapeForCypher(
            file
          )}"})-[:DECLARES|CONTAINS*1..]->(fn:Function)
          MATCH (fn)-[:USES_CONFIG]->(cfg:Config)
          RETURN cfg.name as key, f.file as file
          ORDER BY key
        `;
        },
      },
    ];

  // Try advanced templates first
  for (const t of advancedTemplates) {
    const m = t.match.exec(prompt);
    if (m) {
      const cypher = withLimit(t.cypher(m), limit);
      const rows = await runQuery<any>(driver, cypher, {});
      return formatResult(cypher, rows);
    }
  }

  // Then basic templates
  for (const t of templates) {
    const m = t.match.exec(prompt);
    if (m) {
      const cypher = withLimit(t.cypher(m), limit);
      const rows = await runQuery<any>(driver, cypher, {});
      return formatResult(cypher, rows);
    }
  }

  // Smarter label-aware fallback
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9_\/\.-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const hasApi = /(api|endpoint|route|url|path)/i.test(prompt);
  const hasFunc = /(function|call|invoke|caller|callee)/i.test(prompt);
  const hasFile = /(file|path)/i.test(prompt) || /[\/\.]/.test(prompt);

  const wordsArray = words.map((w) => escapeForCypher(w));
  const wordsList = wordsArray.map((w) => `"${w}"`).join(", ");

  let fallbackCypher = "";

  if (hasApi) {
    // Focus on API nodes and common properties
    fallbackCypher = `
    WITH [${wordsList}] AS ws
    MATCH (a:API)
    WHERE ANY(w IN ws WHERE toLower(coalesce(a.path, a.url, "")) CONTAINS w
                      OR toLower(coalesce(a.method, "")) = w
                      OR toLower(coalesce(a.repoRoot, "")) CONTAINS w)
    RETURN a.direction AS direction,
           coalesce(a.method,"GET") AS method,
           coalesce(a.path, a.url) AS route,
           a.file AS file,
           a.repoRoot AS repoRoot
    ORDER BY repoRoot, file, route
    LIMIT ${limit}
    `;
  } else if (hasFunc) {
    // Surface function names and CALLS edges
    fallbackCypher = `
    WITH [${wordsList}] AS ws
    OPTIONAL MATCH (caller:Function)-[:CALLS]->(callee:Function)
    WITH ws, caller, callee
    WHERE ANY(w IN ws WHERE toLower(coalesce(caller.name,"")) CONTAINS w
                      OR toLower(coalesce(callee.name,"")) CONTAINS w)
    OPTIONAL MATCH (cf:File)-[:DECLARES|CONTAINS*1..]->(caller)
    OPTIONAL MATCH (ff:File)-[:DECLARES|CONTAINS*1..]->(callee)
    RETURN caller.name AS caller, cf.file AS callerFile, callee.name AS callee, ff.file AS calleeFile
    ORDER BY callerFile, caller, callee
    LIMIT ${limit}
    `;
  } else if (hasFile) {
    // File-centric search using file path and repoRoot
    fallbackCypher = `
    WITH [${wordsList}] AS ws
    MATCH (f:File)
    WHERE ANY(w IN ws WHERE toLower(coalesce(f.file,"")) CONTAINS w
                      OR toLower(coalesce(f.repoRoot,"")) CONTAINS w)
    RETURN f.file AS file, f.repoRoot AS repoRoot
    ORDER BY repoRoot, file
    LIMIT ${limit}
    `;
  } else {
    // Generic cross-label property search (as before)
    const genericWhere = words
      .map(
        (w) =>
          `ANY(k IN keys(n) WHERE toString(n[k]) CONTAINS "${escapeForCypher(
            w
          )}")`
      )
      .join(" AND ");
    fallbackCypher = `
    MATCH (n)
    WHERE ${genericWhere}
    RETURN labels(n) as labels, n.id as id, n.name as name, n.file as file, n.repoRoot as repoRoot
    LIMIT ${limit}
    `;
  }

  const rows = await runQuery<any>(driver, fallbackCypher, {});
  return formatResult(fallbackCypher, rows);
}

function withLimit(cypher: string, limit: number): string {
  // Append LIMIT unless query already contains explicit LIMIT
  if (/limit\s+\d+/i.test(cypher)) return cypher;
  return `${cypher}\nLIMIT ${limit}`;
}

function formatResult(cypher: string, rows: any[]): string {
  return [
    "Query",
    "-----",
    cypher.trim(),
    "",
    `Results (${rows.length}):`,
    JSON.stringify(rows, null, 2),
  ].join("\n");
}

function escapeForCypher(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
