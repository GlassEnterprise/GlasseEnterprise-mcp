## 🚀 Using the MCP Tools

Once configured, you can use these 5 tools in Cline:

### 1. **scan** - Analyze Repository

```javascript
Use the scan tool to analyze your codebase:
- paths: [".", "/path/to/another/repo"] (optional)
- watch: true (optional - enables file watching)
- includeGlobs: ["**/*.ts", "**/*.js"] (optional)
- excludeGlobs: ["node_modules/**"] (optional)
```

Example: "Scan the current repository and enable file watching"

### 2. **impact** - Change Impact Analysis

```javascript
Use the impact tool to see what's affected by file changes:
- file: "src/utils/helper.ts" (required)
- repoRoot: "/path/to/repo" (optional)
- depth: 3 (optional - traversal depth)
```

Example: "Show me the impact analysis for src/index.ts"

### 3. **query** - Natural Language Queries

```javascript
Use the query tool with natural language or Cypher:
- prompt: "list all APIs provided by this repository"
- limit: 100 (optional)
```

Examples:

- "List all TypeScript functions that call the database"
- "Show me all provided APIs in this repository"
- "CYPHER: MATCH (f:Function)-[:CALLS]->(g:Function) RETURN f.name, g.name LIMIT 10"

### 4. **learn** - Get Help & Documentation

```javascript
Use the learn tool to understand the system:
No parameters needed
```

Example: "Show me how to use the graph database features"

### 5. **reset** - Clear Database

```javascript
Use the reset tool to clear all data from Neo4j:
- confirm: true (optional - defaults to true)
```

Examples:
- "Reset the database to start fresh"
- "Clear all scanned data from Neo4j"
- "Use reset tool with confirm: false" (to cancel)

This tool is useful when:
- Starting analysis on a new repository
- Clearing stale data after major refactoring
- Removing test data
- Starting fresh after experimentation

## 📋 Quick Start Workflow

1. **First Time Setup:**

   - "Use the learn tool to understand the system"
   - "Reset the database if needed" (optional - clears any existing data)
   - "Scan the current repository"

2. **Daily Usage:**

   - "Show impact analysis for [changed file]"
   - "Query: list all APIs that use authentication"
   - "Query: which functions call the database?"

3. **Advanced Analysis:**

   - "CYPHER: MATCH (r:Repository)-[:CONTAINS]->(f:File) RETURN count(f)"
   - "Query: show me all error messages in the authentication module"

4. **Switching Projects:**

   - "Reset the database to clear old data"
   - "Scan the new repository"

## 💡 Pro Tips

- Start with `learn` to understand the graph schema
- Use `reset` before scanning a new repository to avoid mixing data
- Use `scan` with `watch: true` for ongoing development
- The `query` tool accepts both natural language and raw Cypher (prefix with "CYPHER:")
- Impact analysis helps understand change ripple effects
- The system creates a knowledge graph of your codebase in Neo4j
- The `reset` tool safely clears all data with confirmation

Advanced query templates in src/commands/queryCommand.ts
Circular function-call cycles (optional path/repo scope)
Detects cycles in the Function CALLS graph, optionally filtered by a quoted scope.
Example NL prompts:
"circular function dependencies"
"detect call cycles in 'src'"
Repository-level API consumption cycles
Detects cycles among repositories via CONSUMES_API_FROM edges created during ingestion.
Example NL prompts:
"circular api dependencies across repositories"
"repo api cycles"
Impact of API response change for a specific endpoint
Finds provider and affected internal files (via CALLS) and cross-repo consumer repos/files (via USES_API with route matching).
Example NL prompts:
"impact of api response change in endpoint '/api/test'"
"impact of changing GET '/v1/users'"
These templates run before the original heuristics and are enforced read-only.

Smarter label-aware fallback in src/commands/queryCommand.ts
Prioritizes searches by intent:
API-centric (path/url/method/repoRoot)
Function-centric (Function names and CALLS edges)
File-centric (file and repoRoot)
Otherwise, generic cross-label property search
Keeps LIMIT and sorts outputs for stable results.
Learn command documentation updated in src/commands/learnCommand.ts
Added "Advanced analyses" section with ready-to-run Cypher for:
Circular function-call dependencies
Repository API consumption cycles
Impact of API response change for '/api/test'
How to use:

Circular function cycles:
query: "circular function dependencies"
query: "cyclic calls in 'services'"
API cycles across repos:
query: "circular api dependencies across repositories"
Impact of API change:
query: "impact of api response change in endpoint '/api/test'"
query: "impact of changing GET '/users/:id'"
Notes:

All queries are read-only and capped with LIMIT for safety.
No external AI providers are used. Everything is deterministic and local.
The new behavior preserves existing templates and only improves capabilities when prompts match advanced patterns. If unmatched, a more relevant fallback query is generated based on intent.
