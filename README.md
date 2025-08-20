# MCP Code Relationship Navigator

A Model Context Protocol (MCP) server that scans one or more code repositories using Tree-sitter, extracts entities and relationships, and stores them in Neo4j. Exposes four tools: `scan`, `impact`, `query`, and `learn`. Designed for use with Cline (VS Code) or any MCP-compatible client over stdio.

---

Table of contents
- Overview
- Features
- Prerequisites
- Installation
- Configuration
  - Neo4j
  - mcp-neo4j-cypher (companion server)
  - Environment variables
  - Cline / MCP client configuration
- Usage
  - Quick start workflow
  - Tool reference and examples
- Tool impact & safety
- Examples
- Troubleshooting
- Contributing
- License

Overview
--------
This MCP server builds a code knowledge graph for one or more repositories. It identifies Files, Classes, Functions, Variables, APIs, Config keys, Database tables, Tests, and Error messages and persists a labeled property graph to Neo4j. Use the knowledge graph for code discovery, automated impact analysis, cross-repository dependency inspection, and deterministic natural-language → Cypher queries.

Features
--------
- Multi-language parsing using Tree-sitter (JavaScript/TypeScript, Python, Java, C# and more)
- Repository-level and file-level ingestion with include/exclude globs
- Incremental watch mode (chokidar) for ongoing development
- Neo4j persistence with idempotent upserts for nodes and relationships
- Deterministic NL → Cypher heuristics plus raw Cypher passthrough
- Advanced templates for detecting circular call dependencies, API-impact analysis and cross-repo cycles
- Secure connection handling with optional dev TLS bypass for self-signed certs
- Designed for MCP clients (Cline, other IDE integrations) over stdio

Prerequisites
-------------
- Node.js 18 or later
- Neo4j (Desktop, Aura, or Docker)
- Recommended: APOC plugin enabled on Neo4j for efficient upserts (see Configuration)
- Optional: Cline (VS Code) for a convenient UX, but any MCP stdio client will work

Installation
------------
1. Clone the repository:
   ```bash
   git clone https://github.com/GlassEnterprise/GlasseEnterprise-mcp.git
   cd GlasseEnterprise-mcp
   ```
2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
3. Create a `.env` file in the project root (example below) or provide the same variables through your MCP client configuration.

Configuration
-------------

Neo4j
- Ensure Neo4j is running and reachable.
- Recommended: enable APOC plugin for efficient upserts and advanced procedures.
  - In Neo4j Desktop, enable the APOC plugin for the database.
  - For Docker, mount or enable APOC in the image and set `dbms.security.procedures.unrestricted=apoc.*` if required.

mcp-neo4j-cypher (Companion MCP Server)
- The `mcp-neo4j-cypher` server (if used) is a companion MCP server that can expose read/write Cypher tools to clients. It is not required but can simplify running ad-hoc Cypher queries via MCP.
- Typical configuration steps:
  1. Install and build the companion server (follow its repository README).
  2. Configure the companion server with the same Neo4j connection and credentials as this project.
  3. In your MCP client (Cline or other), register both servers. Example Cline configuration (see Cline section below) shows how to register multiple MCP servers.
- Security note: Companion servers that accept raw Cypher must be deployed only where trusted users operate. Limit access and use read-only mode for public or shared deployments.

Environment variables
- Example `.env` (project root):
  ```
  NEO4J_URI=bolt://localhost:7687
  NEO4J_USERNAME=neo4j
  NEO4J_PASSWORD=your-password
  NEO4J_DATABASE=neo4j

  # Optional performance/timeouts
  NEO4J_CONNECTION_TIMEOUT_MS=8000
  NEO4J_QUERY_TIMEOUT_MS=30000
  NEO4J_MAX_POOL_SIZE=50

  # DEV TLS bypass (self-signed certificates)
  # NODE_TLS_REJECT_UNAUTHORIZED=0
  ```
- Notes:
  - For secured Neo4j (Aura / TLS), use `bolt+s://` in `NEO4J_URI`.
  - For local self-signed certs, `NODE_TLS_REJECT_UNAUTHORIZED=0` will allow connection using `bolt+ssc://` (keeps encryption, avoids strict validation). Use only for local development.

Cline / MCP client configuration
- Add an MCP server entry pointing to the built server script.
- Example Cline settings (VS Code JSON snippet):
  ```json
  {
    "mcpServers": {
      "GlassEnterprise": {
        "command": "node",
        "args": ["/absolute/path/to/GlasseEnterprise-mcp/build/index.js"],
        "env": {
          "NEO4J_URI": "bolt://localhost:7687",
          "NEO4J_USERNAME": "neo4j",
          "NEO4J_PASSWORD": "your-password",
          "NEO4J_DATABASE": "neo4j"
        }
      },
      "mcp-neo4j-cypher": {
        "command": "node",
        "args": ["/absolute/path/to/mcp-neo4j-cypher/build/index.js"],
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
- After configuring, reload the client; tools exposed by the servers should appear (e.g., `scan`, `impact`, `query`, `learn`).

Usage
-----

Quick start workflow
1. `learn` — inspect schema, node labels, relationship types and sample validation queries.
2. `scan` — ingest repository (optionally `watch: true`).
3. `query` — run NL queries or `CYPHER:` queries to explore the graph.
4. `impact` — run change-impact analysis for specific files.

Tool reference and examples
1) scan
- Purpose: Ingest one or more repositories, parse code with Tree-sitter, and persist the extracted entities and relationships to Neo4j.
- Input:
  - `paths?: string[]` — absolute or relative repository roots (default: `[process.cwd()]`)
  - `watch?: boolean` — enable chokidar watcher (default: `false`)
  - `includeGlobs?: string[]` — include patterns
  - `excludeGlobs?: string[]` — exclude patterns
- Example:
  ```json
  { "paths": ["."] }
  ```
  With watcher:
  ```json
  { "paths": ["."] , "watch": true }
  ```

2) impact
- Purpose: Change impact analysis for a file; traverses the graph from a File node and returns affected files, APIs, tables, tests, configs and error messages.
- Input:
  - `file: string` (required)
  - `repoRoot?: string` (recommended)
  - `depth?: number` (default: 3)
- Example:
  ```json
  { "file": "src/index.ts", "repoRoot": "/abs/path/to/repo", "depth": 3 }
  ```

3) query
- Purpose: Natural-language → Cypher heuristics for common intents; accepts raw Cypher when prefixed with `CYPHER:`.
- Input:
  - `prompt: string` (required)
  - `limit?: number` (default: 100)
- NL examples:
  - "list provided apis in path 'src'"
  - "who calls function 'getUser'"
- Raw Cypher example:
  ```
  CYPHER: MATCH (f:Function)-[:CALLS]->(g:Function) RETURN f.name, g.name LIMIT 10
  ```
- Notes:
  - By default the NL heuristics produce read-only Cypher. Raw `CYPHER:` passthrough executes exactly what you provide — ensure queries are safe and read-only in shared environments.

4) learn
- Purpose: Onboarding guide and validation queries.
- Input: none
- Output: Node labels, relationship types, and ready-to-run Cypher snippets for validation and exploration.

Tool impact & safety
--------------------
This section describes the practical effects of running the tools and important safety considerations.

What each tool does (impact)
- `scan`: Writes to Neo4j — creates/merges nodes and relationships. This is the primary write operation and is idempotent (upserts) to allow repeated runs. Requires correct Neo4j credentials.
- `impact`: Read-only analysis over the persisted graph.
- `query`: Intended to be read-only via NL heuristics. Raw `CYPHER:` passthrough executes the supplied Cypher directly; depending on the Cypher you supply, this can be read or write.
- `learn`: Read-only; prints schema and validation queries.

Safety and access control
- Always run `scan` and raw Cypher tools in an environment with appropriate access controls.
- Do not expose raw Cypher execution to untrusted users. Use the companion `mcp-neo4j-cypher` server with read-only mode enabled if you need to allow broader query access.
- For shared deployments, limit Neo4j credentials and use role-based access controls on Neo4j where possible.

Updated tool capabilities (what's new)
- Advanced NL templates for:
  - Circular function-call detection (scoped by path or repo)
  - Repository-level API consumption cycle detection
  - API response-change impact analysis (traces providers → internal callers → external consumers)
- Label-aware intent fallback: queries prioritize API, Function, or File centric templates based on tokens in your prompt, producing more relevant Cypher automatically.
- Deterministic heuristics: All NL → Cypher translation is deterministic and local; no external AI services used.

Examples
--------
- Scan current repo:
  ```json
  {}
  ```
- Scan with watcher and include only TS:
  ```json
  { "paths": ["."], "watch": true, "includeGlobs": ["**/*.ts"], "excludeGlobs": ["**/*.test.ts", "node_modules/**"] }
  ```
- Query for provided APIs:
  ```
  "list provided apis in path 'src'"
  ```
- Raw Cypher to list files:
  ```
  CYPHER: MATCH (f:File) RETURN f.file LIMIT 25
  ```
- Impact for a file:
  ```json
  { "file": "src/index.ts", "depth": 3 }
  ```

Troubleshooting
---------------
- Missing credentials: ensure `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE` are set in the environment or client config.
- TLS/certificate issues (local development): set `NODE_TLS_REJECT_UNAUTHORIZED=0` to allow self-signed certs (use only locally).
- APOC not available: the ingestion prefers `apoc.merge.node(...)` for some upserts. If APOC is unavailable, modify `src/neo4j/saveNodes.ts` to use plain `MERGE` as a fallback.
- No results after scan:
  - Verify include/exclude globs
  - Run `learn` and execute validation Cypher to confirm expected node labels are present
- Performance:
  - Scope scans with `includeGlobs`
  - Increase `NEO4J_MAX_POOL_SIZE` and timeout env vars for large repositories

Contributing
------------
- Contributions are welcome. Suggested workflow:
  1. Fork repository
  2. Create a feature branch
  3. Run tests and linting (if present)
  4. Open a pull request with a clear description of the change
- For changes to Neo4j persistence or Cypher generation, include regression tests and validation queries.

License
-------
MIT
