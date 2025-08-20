import {
  AnyEntity,
  Relationship,
  RelationshipType,
  FunctionEntity,
  APIEntity,
  DatabaseTableEntity,
  DatabaseColumnEntity,
  ConfigEntity,
  ErrorMessageEntity,
  ClassEntity,
  FileEntity,
  RepositoryEntity,
  PackageEntity,
  VariableEntity,
  SpringDataRepositoryEntity,
  SecurityComponentEntity,
  DeveloperEntity,
  TeamEntity,
  CommitEntity,
} from "./types.js";

/**
 * Build relationships between extracted entities.
 * Heuristics:
 * - File CONTAINS all entities in same file
 * - File DECLARES Class/Function/Variable in same file
 * - Class HAS_FUNCTION functions whose span is within class span (same file)
 * - Function CALLS resolution by name within same repo (simple name match)
 * - Function USES_API / PROVIDES_API using function meta lists to API entities in same file/repo
 * - Function QUERIES to DatabaseTable by name (same repo)
 * - Function USES_CONFIG to Config by key (same repo)
 * - Function EMITS_ERROR to ErrorMessage occurring within function span (same file)
 */
export function buildRelationships(entities: AnyEntity[]): Relationship[] {
  const rels: Relationship[] = [];

  const files = entities.filter((e) => e.type === "File") as FileEntity[];
  const classes = entities.filter((e) => e.type === "Class") as ClassEntity[];
  const functions = entities.filter(
    (e) => e.type === "Function"
  ) as FunctionEntity[];
  const apis = entities.filter((e) => e.type === "API") as APIEntity[];
  const tables = entities.filter(
    (e) => e.type === "DatabaseTable"
  ) as DatabaseTableEntity[];
  const configs = entities.filter((e) => e.type === "Config") as ConfigEntity[];
  const errors = entities.filter(
    (e) => e.type === "ErrorMessage"
  ) as ErrorMessageEntity[];
  const packages = entities.filter(
    (e) => e.type === "Package"
  ) as PackageEntity[];
  const variables = entities.filter(
    (e) => e.type === "Variable"
  ) as VariableEntity[];
  const springRepos = entities.filter(
    (e) => e.type === "SpringDataRepository"
  ) as SpringDataRepositoryEntity[];
  const securityComponents = entities.filter(
    (e) => e.type === "SecurityComponent"
  ) as SecurityComponentEntity[];
  const columns = entities.filter(
    (e) => e.type === "DatabaseColumn"
  ) as DatabaseColumnEntity[];
  const developers = entities.filter(
    (e) => e.type === "Developer"
  ) as DeveloperEntity[];
  const teams = entities.filter((e) => e.type === "Team") as TeamEntity[];
  const commits = entities.filter((e) => e.type === "Commit") as CommitEntity[];

  // Index helpers
  const byFile = new Map<string, AnyEntity[]>();
  for (const e of entities) {
    if (!e.file) continue;
    const key = `${e.repoRoot}|${e.file}`;
    const arr = byFile.get(key) ?? [];
    arr.push(e);
    byFile.set(key, arr);
  }

  // File relationships
  for (const f of files) {
    const key = `${f.repoRoot}|${f.file}`;
    const contained = byFile.get(key) ?? [];
    for (const e of contained) {
      if (e.id === f.id) continue;
      rels.push(makeRel("CONTAINS", f.id, e.id));
      if (
        e.type === "Class" ||
        e.type === "Function" ||
        e.type === "Variable"
      ) {
        rels.push(makeRel("DECLARES", f.id, e.id));
      }
    }
  }

  // Class HAS_FUNCTION (span containment)
  for (const c of classes) {
    for (const fn of functions) {
      if (c.repoRoot !== fn.repoRoot || c.file !== fn.file) continue;
      if (!c.span || !fn.span) continue;
      if (
        fn.span.startLine >= c.span.startLine &&
        fn.span.endLine <= c.span.endLine
      ) {
        rels.push(makeRel("HAS_FUNCTION", c.id, fn.id));
      }
    }
  }

  // Function CALLS (name resolution in same repo)
  // Build index: function name -> list of function ids
  const fnByNameByRepo = new Map<string, string[]>();
  for (const fn of functions) {
    const key = `${fn.repoRoot}|${fn.name}`;
    const arr = fnByNameByRepo.get(key) ?? [];
    arr.push(fn.id);
    fnByNameByRepo.set(key, arr);
  }

  for (const fn of functions) {
    const calls = fn.calls ?? [];
    for (const targetName of calls) {
      const key = `${fn.repoRoot}|${targetName}`;
      const targets = fnByNameByRepo.get(key) ?? [];
      for (const targetId of targets) {
        if (targetId !== fn.id) {
          rels.push(makeRel("CALLS", fn.id, targetId));
        }
      }
    }
  }

  // Function -> API relationships
  for (const fn of functions) {
    const provided = fn.apisProvided ?? [];
    for (const p of provided) {
      const matches = apis.filter(
        (a) =>
          a.repoRoot === fn.repoRoot &&
          a.file === fn.file &&
          a.direction === "provided" &&
          a.path === p.path &&
          (a.method || "").toUpperCase() === (p.method || "").toUpperCase()
      );
      for (const a of matches) {
        rels.push(makeRel("PROVIDES_API", fn.id, a.id));
      }
    }

    const consumed = fn.apisUsed ?? [];
    for (const u of consumed) {
      const matches = apis.filter(
        (a) =>
          a.repoRoot === fn.repoRoot &&
          a.file === fn.file &&
          a.direction === "consumed" &&
          a.url === u.url
      );
      for (const a of matches) {
        rels.push(makeRel("USES_API", fn.id, a.id));
      }
    }
  }

  // Function -> DatabaseTable (QUERIES) by name in same repo
  const tableByNameByRepo = new Map<string, string[]>();
  for (const t of tables) {
    const key = `${t.repoRoot}|${t.name}`;
    const arr = tableByNameByRepo.get(key) ?? [];
    arr.push(t.id);
    tableByNameByRepo.set(key, arr);
  }
  for (const fn of functions) {
    for (const tableName of fn.tablesQueried ?? []) {
      const ids = tableByNameByRepo.get(`${fn.repoRoot}|${tableName}`) ?? [];
      for (const id of ids) {
        rels.push(makeRel("QUERIES", fn.id, id));
      }
    }
  }

  // Function -> Config (USES_CONFIG) by key in same repo
  const configByKeyByRepo = new Map<string, string[]>();
  for (const c of configs) {
    const key = `${c.repoRoot}|${c.name}`;
    const arr = configByKeyByRepo.get(key) ?? [];
    arr.push(c.id);
    configByKeyByRepo.set(key, arr);
  }
  for (const fn of functions) {
    for (const key of fn.configsUsed ?? []) {
      const ids = configByKeyByRepo.get(`${fn.repoRoot}|${key}`) ?? [];
      for (const id of ids) {
        rels.push(makeRel("USES_CONFIG", fn.id, id));
      }
    }
  }

  // Data lineage edges
  // Index variables by (repoRoot|file)
  const varsByFile = new Map<string, VariableEntity[]>();
  for (const v of variables) {
    const key = `${v.repoRoot}|${v.file}`;
    const arr = varsByFile.get(key) ?? [];
    arr.push(v);
    varsByFile.set(key, arr);
  }

  function findVarsInFunction(
    fn: FunctionEntity,
    varName: string
  ): VariableEntity[] {
    const list = varsByFile.get(`${fn.repoRoot}|${fn.file}`) ?? [];
    // Prefer variables declared within the function span
    const inSpan = list.filter(
      (v) =>
        v.name === varName &&
        v.span &&
        fn.span &&
        v.span.startLine >= fn.span.startLine &&
        v.span.endLine <= fn.span.endLine
    );
    if (inSpan.length) return inSpan;
    // fallback to variables of same name in file
    return list.filter((v) => v.name === varName);
  }

  // READS_FROM and WRITES_TO
  for (const fn of functions) {
    for (const varName of fn.reads ?? []) {
      const targets = findVarsInFunction(fn, varName);
      for (const v of targets) {
        rels.push(makeRel("READS_FROM", fn.id, v.id));
      }
    }
    for (const varName of fn.writes ?? []) {
      const targets = findVarsInFunction(fn, varName);
      for (const v of targets) {
        rels.push(makeRel("WRITES_TO", fn.id, v.id));
      }
    }

    // TRANSFORMS and DERIVES_FROM
    for (const d of fn.derives ?? []) {
      const targets = findVarsInFunction(fn, d.target);
      for (const t of targets) {
        const tr = makeRel("TRANSFORMS", fn.id, t.id);
        tr.properties = {
          sources: d.sources ?? [],
          ...(d.op ? { op: d.op } : {}),
        };
        rels.push(tr);

        for (const sName of d.sources ?? []) {
          const sources = findVarsInFunction(fn, sName);
          for (const s of sources) {
            rels.push(makeRel("DERIVES_FROM", t.id, s.id));
          }
        }
      }
    }

    // PASSES_TO: variable -> callee function
    for (const p of fn.passesTo ?? []) {
      const vars = findVarsInFunction(fn, p.sourceVar);
      const key = `${fn.repoRoot}|${p.callee}`;
      const targetFns = fnByNameByRepo.get(key) ?? [];
      for (const v of vars) {
        for (const targetId of targetFns) {
          const r = makeRel("PASSES_TO", v.id, targetId);
          r.properties = {
            argIndex: p.argIndex ?? null,
            paramName: p.paramName ?? null,
          };
          rels.push(r);
        }
      }
    }
  }

  // Function -> ErrorMessage (EMITS_ERROR) if error line within function span
  const errorsByFile = new Map<string, ErrorMessageEntity[]>();
  for (const e of errors) {
    const key = `${e.repoRoot}|${e.file}`;
    const arr = errorsByFile.get(key) ?? [];
    arr.push(e);
    errorsByFile.set(key, arr);
  }
  for (const fn of functions) {
    const key = `${fn.repoRoot}|${fn.file}`;
    const errs = errorsByFile.get(key) ?? [];
    for (const er of errs) {
      const line = er.span?.startLine ?? -1;
      if (fn.span && line >= fn.span.startLine && line <= fn.span.endLine) {
        rels.push(makeRel("EMITS_ERROR", fn.id, er.id));
      }
    }
  }

  // Repository -> Package (REPO_DEPENDS_ON_PACKAGE)
  const repositoriesForPackages = entities.filter(
    (e) => e.type === "Repository"
  ) as RepositoryEntity[];
  for (const repo of repositoriesForPackages) {
    const deps = packages.filter((p) => p.repoRoot === repo.repoRoot);
    for (const p of deps) {
      const r = makeRel("REPO_DEPENDS_ON_PACKAGE", repo.id, p.id);
      // attach basic metadata (version/manager) for this repo's usage
      r.properties = {
        manager: (p.meta as any)?.manager ?? null,
        version: (p.meta as any)?.version ?? null,
      };
      rels.push(r);
    }
  }

  // SHARES_PACKAGE_WITH between repositories (single direction A->B where A.repoRoot < B.repoRoot)
  const repoToPkgIds = new Map<string, Set<string>>();
  for (const repo of repositoriesForPackages) {
    const set = new Set<string>();
    for (const p of packages.filter((p) => p.repoRoot === repo.repoRoot)) {
      set.add(p.id);
    }
    repoToPkgIds.set(repo.repoRoot, set);
  }
  const reposArr = repositoriesForPackages.slice();
  reposArr.sort((a, b) =>
    a.repoRoot < b.repoRoot ? -1 : a.repoRoot > b.repoRoot ? 1 : 0
  );
  for (let i = 0; i < reposArr.length; i++) {
    for (let j = i + 1; j < reposArr.length; j++) {
      const A = reposArr[i];
      const B = reposArr[j];
      const setA = repoToPkgIds.get(A.repoRoot) ?? new Set<string>();
      const setB = repoToPkgIds.get(B.repoRoot) ?? new Set<string>();
      let count = 0;
      const shared: string[] = [];
      for (const id of setA) {
        if (setB.has(id)) {
          count++;
          if (shared.length < 10) shared.push(id);
        }
      }
      if (count > 0) {
        const r = makeRel("SHARES_PACKAGE_WITH", A.id, B.id);
        r.properties = { count, packages: shared };
        rels.push(r);
      }
    }
  }

  // Spring Data Repository relationships
  for (const repo of springRepos) {
    // SpringDataRepository -> DatabaseTable (ACCESSES_TABLE)
    if (repo.entityType) {
      const tableName = repo.entityType.toLowerCase() + "s";
      const matchingTables = tables.filter(
        (t) => t.repoRoot === repo.repoRoot && t.name === tableName
      );
      for (const table of matchingTables) {
        rels.push(makeRel("ACCESSES_TABLE", repo.id, table.id));
      }
    }

    // SpringDataRepository -> DatabaseColumn (QUERIES_COLUMN)
    const repoColumns = columns.filter(
      (c) => c.repoRoot === repo.repoRoot && c.file === repo.file
    );
    for (const col of repoColumns) {
      rels.push(makeRel("QUERIES_COLUMN", repo.id, col.id));
    }
  }

  // DatabaseTable -> DatabaseColumn (HAS_COLUMN)
  for (const col of columns) {
    const matchingTables = tables.filter(
      (t) => t.repoRoot === col.repoRoot && t.name === col.table
    );
    for (const table of matchingTables) {
      rels.push(makeRel("HAS_COLUMN", table.id, col.id));
    }
  }

  // SecurityComponent -> API relationships (SECURES_API)
  for (const sec of securityComponents) {
    if (sec.componentType === "SecurityConfig" && sec.configuredPaths) {
      // Match configured paths with API endpoints
      const repoApis = apis.filter(
        (a) => a.repoRoot === sec.repoRoot && a.direction === "provided"
      );

      for (const api of repoApis) {
        const apiPath = api.path || "";
        // Check if any configured path pattern matches this API
        for (const pattern of sec.configuredPaths) {
          if (pathMatchesPattern(apiPath, pattern)) {
            const rel = makeRel("SECURES_API", sec.id, api.id);
            rel.properties = { pattern };
            rels.push(rel);
            break; // Only need one match per API
          }
        }
      }
    }

    // SecurityComponent -> Class relationships for UserDetailsService
    if (sec.componentType === "UserDetailsService") {
      // Link to controllers/classes that might use it
      const repoClasses = classes.filter((c) => c.repoRoot === sec.repoRoot);
      for (const cls of repoClasses) {
        // Check if class name suggests it's a controller
        if (cls.name.includes("Controller") || cls.name.includes("Service")) {
          rels.push(makeRel("USED_BY", sec.id, cls.id));
        }
      }
    }
  }

  // Cross-repository API relationships
  const repositories = entities.filter(
    (e) => e.type === "Repository"
  ) as RepositoryEntity[];
  rels.push(...buildCrossRepositoryAPIRelationships(repositories, apis));

  // Developer and Team relationships
  rels.push(
    ...buildDeveloperTeamRelationships(
      developers,
      teams,
      commits,
      repositories,
      files
    )
  );

  return dedupeRelationships(rels);
}

function makeRel(
  type: RelationshipType,
  fromId: string,
  toId: string
): Relationship {
  return {
    id: `${fromId}|${type}|${toId}`,
    type,
    fromId,
    toId,
  };
}

/**
 * Build cross-repository API relationships between repositories.
 * Creates:
 * - REPO_PROVIDES_API: Repository -> API (provided)
 * - REPO_USES_API: Repository -> API (consumed)
 * - CONSUMES_API_FROM: Repository -> Repository (when repo A consumes API provided by repo B)
 */
function buildCrossRepositoryAPIRelationships(
  repositories: RepositoryEntity[],
  apis: APIEntity[]
): Relationship[] {
  const rels: Relationship[] = [];

  // Group APIs by repository and direction
  const apisByRepo = new Map<
    string,
    { provided: APIEntity[]; consumed: APIEntity[] }
  >();

  for (const api of apis) {
    const repoKey = api.repoRoot;
    if (!apisByRepo.has(repoKey)) {
      apisByRepo.set(repoKey, { provided: [], consumed: [] });
    }
    const repoApis = apisByRepo.get(repoKey)!;

    if (api.direction === "provided") {
      repoApis.provided.push(api);
    } else {
      repoApis.consumed.push(api);
    }
  }

  // Create repository-level API relationships
  for (const repo of repositories) {
    const repoApis = apisByRepo.get(repo.repoRoot);
    if (!repoApis) continue;

    // Repository PROVIDES APIs
    for (const providedApi of repoApis.provided) {
      rels.push(makeRel("REPO_PROVIDES_API", repo.id, providedApi.id));
    }

    // Repository USES APIs
    for (const consumedApi of repoApis.consumed) {
      rels.push(makeRel("REPO_USES_API", repo.id, consumedApi.id));
    }
  }

  // Cross-repository API matching
  for (const consumerRepo of repositories) {
    const consumerApis = apisByRepo.get(consumerRepo.repoRoot);
    if (!consumerApis?.consumed.length) continue;

    for (const consumedApi of consumerApis.consumed) {
      // Try to match this consumed API with provided APIs from other repositories
      for (const providerRepo of repositories) {
        if (providerRepo.repoRoot === consumerRepo.repoRoot) continue; // Skip same repo

        const providerApis = apisByRepo.get(providerRepo.repoRoot);
        if (!providerApis?.provided.length) continue;

        for (const providedApi of providerApis.provided) {
          if (isAPIMatch(consumedApi, providedApi)) {
            // Create relationship between repositories
            rels.push(
              makeRel("CONSUMES_API_FROM", consumerRepo.id, providerRepo.id)
            );

            // Add metadata to track the specific API match
            const relWithMeta = rels[rels.length - 1];
            relWithMeta.properties = {
              consumedAPI: consumedApi.id,
              providedAPI: providedApi.id,
              matchConfidence: calculateAPIMatchConfidence(
                consumedApi,
                providedApi
              ),
            };
          }
        }
      }
    }
  }

  return rels;
}

/**
 * Determine if a consumed API matches a provided API.
 * Uses heuristics like URL/path matching, method matching, etc.
 */
function isAPIMatch(consumedApi: APIEntity, providedApi: APIEntity): boolean {
  const consumedUrl = consumedApi.url || "";
  const providedPath = providedApi.path || "";

  const cPath = normalizeAPIPath(consumedUrl);
  const pPath = normalizeAPIPath(providedPath);

  // 1) Exact normalized path match
  if (cPath.length > 0 && cPath === pPath) {
    return methodsMatch(consumedApi.method, providedApi.method);
  }

  // 1b) Match with /api/ prefix present in consumed or provided path
  const rawConsumed = consumedUrl.startsWith("/")
    ? consumedUrl
    : "/" + consumedUrl;
  const rawProvided = providedPath.startsWith("/")
    ? providedPath
    : "/" + providedPath;
  if (
    normalizeAPIPath(rawConsumed) === normalizeAPIPath(rawProvided) ||
    normalizeAPIPath("/api" + rawConsumed) === normalizeAPIPath(rawProvided) ||
    normalizeAPIPath(rawConsumed) === normalizeAPIPath("/api" + rawProvided)
  ) {
    return methodsMatch(consumedApi.method, providedApi.method);
  }

  // 2) Consumed path contains provided path (e.g., baseURL + provided path)
  if (pPath.length > 1 && cPath.includes(pPath)) {
    return methodsMatch(consumedApi.method, providedApi.method);
  }

  // 3) Template/parameterized path match (/:id or /{id})
  try {
    const regex = pathRegexFromTemplate(pPath);
    if (regex.test(cPath)) {
      return methodsMatch(consumedApi.method, providedApi.method);
    }
  } catch {
    // ignore regex build errors
  }

  return false;
}

/**
 * Check if HTTP methods match (allowing for undefined/default values)
 */
function methodsMatch(
  consumedMethod?: string,
  providedMethod?: string
): boolean {
  const normalizedConsumed = (consumedMethod || "GET").toUpperCase();
  const normalizedProvided = (providedMethod || "GET").toUpperCase();
  return normalizedConsumed === normalizedProvided;
}

/**
 * Normalize API paths for better matching
 */
function normalizeAPIPath(path: string): string {
  if (!path) return "";

  // Remove protocol and domain if present
  let normalized = path.replace(/^https?:\/\/[^/]+/, "");

  // Remove query string and hash
  normalized = normalized.split("?")[0].split("#")[0];

  // Remove template literal placeholders if any slipped through
  normalized = normalized.replace(/\$\{[^}]+\}/g, "");

  // Collapse multiple slashes
  normalized = normalized.replace(/\/{2,}/g, "/");

  // Ensure starts with /
  if (!normalized.startsWith("/")) {
    normalized = "/" + normalized;
  }

  // Remove trailing slash
  if (normalized.endsWith("/") && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }

  // Strip common API prefixes
  normalized = normalized.replace(/^\/api(\/|$)/i, "/");
  normalized = normalized.replace(/^\/api-v\d+(\/|$)/i, "/");
  normalized = normalized.replace(/^\/api\/v\d+(\/|$)/i, "/");

  // Try decode URI components (best effort)
  try {
    normalized = decodeURI(normalized);
  } catch {
    // ignore
  }

  return normalized;
}

/**
 * Convert an API path template (Express/Spring styles) to a regex.
 * Supports ":id" and "{id}" style parameters.
 */
function pathRegexFromTemplate(template: string): RegExp {
  if (!template) return /^$/i;
  // Normalize first
  const p = normalizeAPIPath(template);
  // Split on parameter tokens and escape static segments
  const parts = p.split(/(\{[^}]+\}|:[A-Za-z0-9_]+)/g);
  const reStr = parts
    .map((seg) =>
      /^\{[^}]+\}$|^:[A-Za-z0-9_]+$/.test(seg)
        ? "([^/]+)"
        : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
    .join("");
  return new RegExp("^" + reStr + "$", "i");
}

/**
 * Calculate confidence score for API matching (0-1)
 */
function calculateAPIMatchConfidence(
  consumedApi: APIEntity,
  providedApi: APIEntity
): number {
  let confidence = 0;

  // Exact path match gets highest confidence
  if (consumedApi.url === providedApi.path) {
    confidence += 0.5;
  } else if (consumedApi.url?.includes(providedApi.path || "")) {
    confidence += 0.3;
  }

  // Boost confidence if match is due to /api/ prefix normalization
  const rawConsumed = consumedApi.url?.startsWith("/")
    ? consumedApi.url
    : "/" + (consumedApi.url ?? "");
  const rawProvided = providedApi.path?.startsWith("/")
    ? providedApi.path
    : "/" + (providedApi.path ?? "");
  if (
    normalizeAPIPath(rawConsumed) === normalizeAPIPath(rawProvided) ||
    normalizeAPIPath("/api" + rawConsumed) === normalizeAPIPath(rawProvided) ||
    normalizeAPIPath(rawConsumed) === normalizeAPIPath("/api" + rawProvided)
  ) {
    confidence += 0.2;
  }

  // Method match adds confidence
  if (methodsMatch(consumedApi.method, providedApi.method)) {
    confidence += 0.3;
  }

  // Same file/repo reduces confidence (prefer cross-repo matches)
  if (consumedApi.repoRoot === providedApi.repoRoot) {
    confidence -= 0.2;
  }

  // Longer, more specific paths get higher confidence
  const pathLength = (providedApi.path || "").length;
  if (pathLength > 10) confidence += 0.1;
  if (pathLength > 20) confidence += 0.1;

  return Math.max(0, Math.min(1, confidence));
}

/**
 * Check if an API path matches a Spring Security pattern
 * Supports patterns like /api/**, /api/admin/*, etc.
 */
function pathMatchesPattern(apiPath: string, pattern: string): boolean {
  if (!apiPath || !pattern) return false;

  // Normalize paths
  const normalizedPath = normalizeAPIPath(apiPath);
  let normalizedPattern = pattern.trim();

  // Convert Spring/Ant-style patterns to regex
  // ** matches any number of directories
  // * matches any characters except /
  normalizedPattern = normalizedPattern
    .replace(/\*\*/g, ".*") // ** matches anything
    .replace(/\*/g, "[^/]*") // * matches anything except /
    .replace(/\//g, "\\/"); // Escape forward slashes

  // Add anchors for exact matching
  const regex = new RegExp(`^${normalizedPattern}$`);

  return regex.test(normalizedPath);
}

/**
 * Build relationships between developers, teams, commits, and repositories
 */
function buildDeveloperTeamRelationships(
  developers: DeveloperEntity[],
  teams: TeamEntity[],
  commits: CommitEntity[],
  repositories: RepositoryEntity[],
  files: FileEntity[]
): Relationship[] {
  const rels: Relationship[] = [];

  // Developer -> Team relationships (BELONGS_TO)
  // Match developers to teams by repository and team assignment
  for (const developer of developers) {
    if (developer.teamId) {
      // Direct team assignment
      const team = teams.find(
        (t) =>
          t.repoRoot === developer.repoRoot &&
          (t.id === developer.teamId || t.name === developer.teamId)
      );
      if (team) {
        rels.push(makeRel("BELONGS_TO", developer.id, team.id));
      }
    } else {
      // Infer team membership from repository
      const repoTeams = teams.filter((t) => t.repoRoot === developer.repoRoot);
      if (repoTeams.length === 1) {
        // If there's only one team for this repo, assign developer to it
        rels.push(makeRel("BELONGS_TO", developer.id, repoTeams[0].id));
      }
    }
  }

  // Team -> Repository relationships (OWNS_REPOSITORY)
  for (const team of teams) {
    const repository = repositories.find((r) => r.repoRoot === team.repoRoot);
    if (repository) {
      const rel = makeRel("OWNS_REPOSITORY", team.id, repository.id);
      rel.properties = {
        since: team.meta?.since || new Date().toISOString(),
        teamSize: team.size,
      };
      rels.push(rel);
    }
  }

  // Developer -> Repository relationships (CONTRIBUTED_TO)
  for (const developer of developers) {
    const repository = repositories.find(
      (r) => r.repoRoot === developer.repoRoot
    );
    if (repository) {
      const rel = makeRel("CONTRIBUTED_TO", developer.id, repository.id);
      rel.properties = {
        commits: developer.totalCommits || 0,
        firstCommit: developer.firstCommit,
        lastCommit: developer.lastCommit,
        primaryLanguages: developer.primaryLanguages || [],
      };
      rels.push(rel);
    }
  }

  // Developer -> Commit relationships (COMMITTED)
  for (const commit of commits) {
    // Find matching developer by email
    const developer = developers.find(
      (d) =>
        d.repoRoot === commit.repoRoot &&
        (d.email === commit.authorEmail ||
          d.aliases?.includes(commit.authorEmail || "") ||
          d.name === commit.author)
    );

    if (developer) {
      const rel = makeRel("COMMITTED", developer.id, commit.id);
      rel.properties = {
        timestamp: commit.timestamp,
        additions: commit.additions,
        deletions: commit.deletions,
        filesChanged: commit.filesChanged?.length || 0,
      };
      rels.push(rel);
    }
  }

  // Repository -> Commit relationships (CONTAINS_COMMIT)
  for (const commit of commits) {
    const repository = repositories.find((r) => r.repoRoot === commit.repoRoot);
    if (repository) {
      rels.push(makeRel("CONTAINS_COMMIT", repository.id, commit.id));
    }
  }

  // Commit -> File relationships (MODIFIED_FILE)
  for (const commit of commits) {
    for (const changedFile of commit.filesChanged || []) {
      const file = files.find(
        (f) => f.repoRoot === commit.repoRoot && f.file === changedFile
      );
      if (file) {
        const rel = makeRel("MODIFIED_FILE", commit.id, file.id);
        rel.properties = {
          timestamp: commit.timestamp,
        };
        rels.push(rel);
      }
    }
  }

  // Developer collaboration relationships (COLLABORATES_WITH)
  // Find developers who worked on the same files
  const collaborationMap = new Map<string, Set<string>>();

  for (const commit of commits) {
    const developer = developers.find(
      (d) =>
        d.repoRoot === commit.repoRoot &&
        (d.email === commit.authorEmail ||
          d.aliases?.includes(commit.authorEmail || "") ||
          d.name === commit.author)
    );

    if (developer && commit.filesChanged) {
      for (const filePath of commit.filesChanged) {
        const key = `${commit.repoRoot}|${filePath}`;
        if (!collaborationMap.has(key)) {
          collaborationMap.set(key, new Set());
        }
        collaborationMap.get(key)!.add(developer.id);
      }
    }
  }

  // Create collaboration relationships
  for (const [, developerIds] of collaborationMap) {
    const devArray = Array.from(developerIds);
    for (let i = 0; i < devArray.length; i++) {
      for (let j = i + 1; j < devArray.length; j++) {
        const dev1Id = devArray[i];
        const dev2Id = devArray[j];

        // Create bidirectional collaboration
        const rel1 = makeRel("COLLABORATES_WITH", dev1Id, dev2Id);
        const rel2 = makeRel("COLLABORATES_WITH", dev2Id, dev1Id);

        // Count shared files for collaboration strength
        let sharedFiles = 0;
        for (const [, collaborators] of collaborationMap) {
          if (collaborators.has(dev1Id) && collaborators.has(dev2Id)) {
            sharedFiles++;
          }
        }

        rel1.properties = { sharedFiles };
        rel2.properties = { sharedFiles };

        rels.push(rel1, rel2);
      }
    }
  }

  // Team management relationships (MANAGES_TEAM, HAS_MEMBER)
  for (const team of teams) {
    // Team lead relationships
    if (team.lead) {
      const leadDeveloper = developers.find(
        (d) =>
          d.repoRoot === team.repoRoot &&
          (d.name === team.lead || d.email === team.lead)
      );
      if (leadDeveloper) {
        rels.push(makeRel("MANAGES_TEAM", leadDeveloper.id, team.id));
      }
    }

    // Team membership relationships
    const teamMembers = developers.filter(
      (d) =>
        d.repoRoot === team.repoRoot &&
        (d.teamId === team.id || d.teamId === team.name)
    );

    for (const member of teamMembers) {
      const rel = makeRel("HAS_MEMBER", team.id, member.id);
      rel.properties = {
        role:
          member.id === developers.find((d) => d.name === team.lead)?.id
            ? "lead"
            : "member",
        joinDate: member.firstCommit,
        contributions: member.totalCommits || 0,
      };
      rels.push(rel);
    }
  }

  return rels;
}

function dedupeRelationships(rels: Relationship[]): Relationship[] {
  const seen = new Set<string>();
  const out: Relationship[] = [];
  for (const r of rels) {
    const key = `${r.fromId}|${r.type}|${r.toId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
