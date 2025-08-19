# MCP Code Relationship Navigator

A Model Context Protocol (MCP) server that scans one or more code repositories using Tree-sitter, extracts entities and relationships, and stores them in Neo4j. It exposes four tools:

- scan — Ingest repositories and optionally watch for incremental changes
- impact — Change impact analysis for a given file
- query — Hybrid natural-language or raw Cypher queries via neo4j-database MCP integration
- learn — Onboarding guide with schema, examples, and validation queries

Works with Cline (VS Code) and any MCP-compatible client over stdio.

## Hybrid Query Architecture

This MCP now integrates with the `neo4j-database` MCP server to provide a hybrid query experience:

- **Database Check**: Before any query, verifies Neo4j database exists and contains data
- **CYPHER: Prefix**: Raw Cypher queries are forwarded directly to neo4j-database MCP
- **Natural Language**: Converted to Cypher using heuristics, then forwarded to neo4j-database MCP
- **Error Handling**: Clear messages when database is empty or unavailable

This architecture provides better separation of concerns and leverages the specialized neo4j-database tooling.

### Database Check Behavior

The query tool now performs automatic database validation before processing any query:

1. **Schema Check**: Verifies the Neo4j database schema is accessible
2. **Content Check**: Confirms the database contains actual data (node count > 0)
3. **Clear Messaging**: Returns helpful error messages if database is missing or empty

**Example error message when database is empty:**

```
Database Check Failed

Neo4j database is empty (0 nodes). Please run the 'scan' tool first to populate the database with code entities and relationships.
```

### Hybrid Query Flow Examples

**Raw Cypher Query:**

```
Input: "CYPHER: MATCH (f:Function) RETURN f.name LIMIT 5"
→ Database check passes
→ Forward to neo4j-database MCP: "MATCH (f:Function) RETURN f.name LIMIT 5"
→ Return formatted results
```

**Natural Language Query:**

```
Input: "list provided apis in path 'src'"
→ Database check passes
→ Convert to: "MATCH (a:API {direction:"provided"}) WHERE a.repoRoot CONTAINS "src" RETURN a.method, a.path, a.file ORDER BY a.file, a.path"
→ Forward to neo4j-database MCP
→ Return formatted results
```

**Database Empty Scenario:**

```
Input: "show all functions"
→ Database check fails (0 nodes found)
→ Return error message with guidance
→ No query forwarded to neo4j-database MCP
```

## Why use this

- Build a knowledge graph of your repositories , codebase: Files, Classes, Functions, Variables
- Detect APIs provided and consumed, config usages, database tables, tests, and error messages
- Understand dependencies such as CALLS, PROVIDES_API, USES_API, QUERIES, USES_CONFIG, EMITS_ERROR
- Run NL/Cypher queries and impact analysis for safer refactors and faster navigation

## Features

- Multi-language parsing via Tree-sitter: JavaScript/TypeScript, Python, Java, C#
- Include/exclude file globs and ignore patterns
- Incremental watch mode using chokidar
- Neo4j persistence with upserts (nodes and relationships)
- Deterministic NL → Cypher heuristics, plus raw Cypher passthrough with CYPHER:
- Secure Neo4j connection handling, with a dev-only TLS bypass option for self-signed certs

## Requirements

- Node.js >= 18
- Neo4j (Desktop, Aura, or Docker)
- **mcp-neo4j-cypher** - Neo4j database MCP server (installed automatically via uvx)
- Recommended: APOC plugin enabled on Neo4j
  - Note: Generic non-API entities are upserted with `apoc.merge.node(...)`. API nodes use plain `MERGE`. If APOC is unavailable, you may adapt `src/neo4j/saveNodes.ts` to use plain MERGE for all entities.

Optional performance/timeouts (environment variables):

- `NEO4J_CONNECTION_TIMEOUT_MS` (default 8000)
- `NEO4J_QUERY_TIMEOUT_MS` (default 30000)
- `NEO4J_MAX_POOL_SIZE` (default 50)
- `NODE_TLS_REJECT_UNAUTHORIZED=0` (dev only; enables self-signed TLS via bolt+ssc)

### Neo4j Database MCP Dependency

This MCP integrates with [mcp-neo4j-cypher](https://github.com/modelcontextprotocol/servers/tree/main/src/neo4j) for query execution. The dependency is automatically managed via `uvx` - no manual installation required.

## Installation

```bash
cd GlassEnterprise
npm install
npm run build
```

Create a `.env` at the project root (the server loads `../.env` relative to `build/`):

```bash
# Required
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
NEO4J_DATABASE=neo4j

# Optional
NEO4J_CONNECTION_TIMEOUT_MS=8000
NEO4J_QUERY_TIMEOUT_MS=30000
NEO4J_MAX_POOL_SIZE=50

# DEV TLS bypass (self-signed): keeps encryption but skips strict verification
# NODE_TLS_REJECT_UNAUTHORIZED=0
```

Manual run (for testing over stdio without a GUI client):

```bash
node build/index.js
```

This server speaks MCP over stdio (no HTTP listener). Use an MCP client (e.g., Cline) to call tools.

## How it works (high level)

1. scan

- Collects files per repository (include/exclude globs)
- Parses code with Tree-sitter to extract entities:
  - File, Class, Function, Variable
  - API (direction = provided | consumed), Config key usage, DatabaseTable, Test, ErrorMessage
- Builds relationships:
  - CONTAINS, DECLARES, HAS_FUNCTION
  - CALLS, PROVIDES_API, USES_API, QUERIES, USES_CONFIG, EMITS_ERROR
- Persists nodes and relationships to Neo4j (upserts)
- Optional watch mode applies incremental updates

2. impact

- Seeds at a File node, traverses declared/contained entities and dependency-like edges for N hops, maps back to affected Files, summarizes affected files/APIs/tables/configs/errors/functions/classes/tests

3. query

- Natural-language → Cypher heuristics for common intents
- Advanced templates for cycles and API-change impact
- Smarter fallbacks (API-centric, function-centric, file-centric), plus raw `CYPHER:` passthrough

4. learn

- Prints an onboarding guide with node labels, relationship types, validation queries, and advanced ready-to-run Cypher examples

## Using with Cline (VS Code)

Method A: Cline settings UI

1. Open Cline settings in VS Code
2. Add an MCP server:
   - Name: `GlassEnterprise`
   - Command: `node`
   - Arguments (update path to match your system):
     ```json
     ["/Users/ahman/Documents/Cline/GlassEnterprise/build/index.js"]
     ```
   - Environment:
     ```json
     {
       "NEO4J_URI": "bolt://localhost:7687",
       "NEO4J_USERNAME": "neo4j",
       "NEO4J_PASSWORD": "your-password",
       "NEO4J_DATABASE": "neo4j",
       "NEO4J_CONNECTION_TIMEOUT_MS": "8000",
       "NEO4J_QUERY_TIMEOUT_MS": "30000",
       "NEO4J_MAX_POOL_SIZE": "50"
       // For local dev with self-signed certs:
       // "NODE_TLS_REJECT_UNAUTHORIZED": "0"
     }
     ```
3. Reload Cline. You should see the tools: `scan`, `impact`, `query`, `learn`.

Method B: Command-line test (without Cline)

```bash
# List tools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node build/index.js

# Call a tool (example: learn)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"learn","arguments":{}}}' | node build/index.js
```

## Using with other MCP clients/IDEs

Any MCP client that launches a stdio server can use this:

- Command: `node`
- Args: `["/absolute/path/to/GlassEnterprise/build/index.js"]`
- Env: same Neo4j variables as above

If your client has a JSON config, it will usually look like:

```json
{
  "mcpServers": {
    "GlassEnterprise": {
      "command": "node",
      "args": ["/absolute/path/to/GlassEnterprise/build/index.js"],
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "your-password",
        "NEO4J_DATABASE": "neo4j"
      }
    }
  }
}
```

## Tool reference and examples

The server declares tools in `src/index.ts`.

### 1) scan

Description:

- Scan one or more repositories using Tree-sitter to extract entities and relationships, then store them in Neo4j. Optionally enables a file watcher for incremental updates.

Input:

- `paths?: string[]` — absolute or relative repository roots. Default: `[process.cwd()]`
- `watch?: boolean` — enable chokidar watcher. Default: `false`
- `includeGlobs?: string[]` — include patterns, e.g., `["**/*.ts", "**/*.js"]`
- `excludeGlobs?: string[]` — exclude patterns, e.g., `["node_modules/**"]`

Examples:

- Minimal (current repo):
  ```json
  {}
  ```
- Custom paths with watch:
  ```json
  { "paths": [".", "/path/to/another/repo"], "watch": true }
  ```
- Scoped by glob:
  ```json
  {
    "includeGlobs": ["**/*.ts"],
    "excludeGlobs": ["**/*.test.ts", "node_modules/**"]
  }
  ```

Notes:

- Watch mode applies incremental updates when files change (chokidar)
- Output includes a summary of repositories, files scanned, entities, relationships

### 2) impact

Description:

- Change impact analysis for a file. Returns affected files/APIs/tables/tests via dependency traversal.

Input:

- `file: string` (required) — path to file (absolute or relative to repo)
- `repoRoot?: string` (recommended) — repository root path to disambiguate
- `depth?: number` — traversal depth (default 3)

Examples:

- Basic:
  ```json
  { "file": "src/index.ts" }
  ```
- With explicit repoRoot and deeper traversal:
  ```json
  { "file": "src/utils/helper.ts", "repoRoot": "/abs/path/to/repo", "depth": 4 }
  ```

Output includes:

- Affected file paths
- Provided/Consumed APIs
- Database tables
- Config keys
- Error messages
- Functions and Classes touched
- Related test files

### 3) query

Description:

- Run a natural language query. Converts to Cypher or accepts raw `CYPHER: ...` queries.

Input:

- `prompt: string` (required)
- `limit?: number` (default 100; appended unless query already has LIMIT)

Raw Cypher passthrough:

```text
CYPHER: MATCH (f:Function)-[:CALLS]->(g:Function) RETURN f.name, g.name LIMIT 10
```

Natural language templates (examples):

- Impact of a file change:
  ```text
  "affected files for file 'src/index.ts'"
  ```
- Provided APIs in a path:
  ```text
  "list provided apis in path 'src'"
  ```
- Consumed APIs in a path:
  ```text
  "show consumed apis for path 'services'"
  ```
- Who calls a function:
  ```text
  "which functions call function 'getUser'?"
  ```
- Configs used by a file:
  ```text
  "what configs are used in file 'src/app.ts'?"
  ```

Advanced templates:

- Circular function-call dependencies (optional path scope)
  - "circular function dependencies"
  - "cyclic calls in 'src'"
- Repository-level API consumption cycles
  - "circular api dependencies across repositories"
- Impact of API response change for a specific endpoint
  - "impact of api response change in endpoint '/api/test'"
  - "impact of changing GET '/v1/users'"

Label-aware fallbacks:

- API-centric when prompt suggests API concepts
- Function-centric when discussing calls/invocations
- File-centric when path-like tokens are present
- Generic cross-label property search otherwise

Result format:

- Echoes the Cypher used and returns a JSON array of records

### 4) learn

Description:

- Onboarding walkthrough of the repository graph. Explains schema, common queries, and advanced analyses.

Input:

- none

Output includes:

- Node labels: Repository, File, Class, Function, Variable, API, DatabaseTable, Config, Test, ErrorMessage
- Relationship types: CONTAINS, DECLARES, HAS_FUNCTION, CALLS, PROVIDES_API, USES_API, QUERIES, USES_CONFIG, EMITS_ERROR
- Validation queries and advanced analyses (ready-to-run Cypher)

## Quick start workflow

1. learn

- Understand what’s in the graph and how to query it

2. scan

- Ingest the current repository (optionally watch for changes)
- Example args:
  - `{}`
  - `{ "watch": true }`
  - `{ "paths": ["."], "includeGlobs": ["**/*.ts"], "excludeGlobs": ["**/*.test.ts", "node_modules/**"] }`

3. query

- Examples:
  - `"list provided apis in path 'src'"`
  - `"who calls function 'getUser'"`
  - `"CYPHER: MATCH (f:File) RETURN f.file LIMIT 25"`

4. impact

- Example:
  - `{ "file": "src/index.ts", "repoRoot": "/absolute/repo/path", "depth": 3 }`

## Troubleshooting

- Neo4j credentials missing
  - Ensure `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE` are set
- TLS/certificate issues (local dev)
  - Set `NODE_TLS_REJECT_UNAUTHORIZED=0` to allow self-signed (connection will use `bolt+ssc://`)
- Aura/secure usage
  - The server prefers secure `bolt+s://`; ensure URI/creds are correct
- APOC not available
  - Non-API entities use `apoc.merge.node`; enable APOC or modify `src/neo4j/saveNodes.ts` to use plain `MERGE`
- No results after scan
  - Check include/exclude globs; confirm files were discovered
  - Validate using `learn` output and quick validation queries
- Large repository performance
  - Scope with `includeGlobs`/`excludeGlobs`
  - Increase pool size/timeouts via env vars
- Connection issues
  - Tune `NEO4J_*` timeouts/pool
  - Verify Neo4j is running and reachable on the specified port

## Security

- Do not commit secrets; use environment variables
- Restrict Neo4j to trusted networks
- Use strong passwords and rotate as needed

## License

MIT
