#!/usr/bin/env node

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Load .env from project root regardless of CWD (build/ -> ../.env)
config({ path: resolve(__dirname, "../.env") });

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { Logger } from "./utils/logger.js";
import { getDriver, Neo4jConfig } from "./neo4j/connection.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { upsertEntitiesBatch } from "./neo4j/saveNodes.js";
import { upsertRelationshipsBatch } from "./neo4j/saveRelationships.js";
import { scanRepositories } from "./scanner/treeSitterParser.js";
import { extractEntities } from "./scanner/astExtractor.js";
import { buildRelationships } from "./scanner/relationshipBuilder.js";
import { runImpactAnalysis } from "./commands/impactCommand.js";
import { runNaturalLanguageQuery } from "./commands/queryCommand.js";
import { runLearn } from "./commands/learnCommand.js";
import { extractDependencies } from "./scanner/dependencyExtractor.js";

// NEW: repository entity creation helpers
import { AnyEntity } from "./scanner/types.js";
import { basename } from "path";
import { createHash } from "crypto";

const logger = new Logger("MCP-CRN");

// Initialize MCP server
const server = new Server(
  { name: "GlassEnterprise", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// Neo4j MCP client for query delegation
let neo4jMcpClient: Client | null = null;

// Initialize connection to neo4j-database MCP
async function initializeNeo4jMcpClient(): Promise<Client> {
  if (neo4jMcpClient) {
    return neo4jMcpClient;
  }

  try {
    // Create MCP client to connect to neo4j-database server
    const client = new Client(
      { name: "GlassEnterprise-neo4j-client", version: "0.1.0" },
      { capabilities: {} }
    );

    // Use uvx to run the neo4j-database MCP server
    const transport = new StdioClientTransport({
      command: "/Users/ahman/.local/bin/uvx",
      args: ["mcp-neo4j-cypher@0.3.1", "--transport", "stdio"],
      env: {
        ...process.env,
        // Pass through Neo4j configuration
        NEO4J_URI: process.env.NEO4J_URI || "bolt://localhost:7687",
        NEO4J_USERNAME: process.env.NEO4J_USERNAME || "neo4j",
        NEO4J_PASSWORD: process.env.NEO4J_PASSWORD || "password",
        NEO4J_DATABASE: process.env.NEO4J_DATABASE || "neo4j",
      },
    });

    await client.connect(transport);
    neo4jMcpClient = client;
    logger.info("Successfully connected to neo4j-database MCP");
    return client;
  } catch (error) {
    logger.error("Failed to connect to neo4j-database MCP:", error);
    throw new Error(
      `Could not connect to neo4j-database MCP: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// Helper: stable id + repository entity
function stableId(parts: string[]): string {
  return createHash("md5").update(parts.join("|")).digest("hex");
}
function makeRepositoryEntity(repoRoot: string): AnyEntity {
  return {
    id: stableId([repoRoot, "Repository"]),
    type: "Repository",
    name: basename(repoRoot),
    repoRoot,
    meta: {},
  };
}

// Available MCP tools
const AVAILABLE_TOOLS: Tool[] = [
  {
    name: "scan",
    description:
      "Scan one or more repositories using Tree-sitter to extract entities and relationships, then store them in Neo4j. Optionally enables a file watcher for incremental updates.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          description:
            "Array of absolute or relative paths to repositories. If omitted, uses current working directory.",
          items: { type: "string" },
        },
        watch: {
          type: "boolean",
          description:
            "Enable chokidar file watching for incremental updates after initial scan.",
          default: false,
        },
        includeGlobs: {
          type: "array",
          description: "Optional include glob patterns",
          items: { type: "string" },
        },
        excludeGlobs: {
          type: "array",
          description: "Optional exclude glob patterns",
          items: { type: "string" },
        },
      },
      required: [],
    },
  },
  {
    name: "impact",
    description:
      "Impact analysis for a file. Returns affected files/APIs/tables/tests in a dependency graph.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the changed file" },
        repoRoot: {
          type: "string",
          description:
            "Repository root path for disambiguation (optional but recommended)",
        },
        depth: {
          type: "number",
          description: "Traversal depth for relationships",
          default: 3,
        },
      },
      required: ["file"],
    },
  },
  {
    name: "query",
    description:
      "Run a natural language query. Converts to Cypher or accepts raw 'CYPHER: ...' queries.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Natural language query" },
        limit: {
          type: "number",
          description: "Max results",
          default: 100,
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "learn",
    description:
      "Onboarding walkthrough of the repository graph. Explains schema, common queries, and examples.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: AVAILABLE_TOOLS };
});

// Resolve Neo4j driver
function getNeo4jConfig(): Neo4jConfig {
  const cfg: Neo4jConfig = {
    uri: process.env.NEO4J_URI || "bolt://localhost:7687",
    username: process.env.NEO4J_USERNAME || "neo4j",
    password: process.env.NEO4J_PASSWORD || "password",
    database: process.env.NEO4J_DATABASE || "neo4j",
  };
  if (!cfg.uri || !cfg.username || !cfg.password) {
    throw new Error(
      "Missing Neo4j configuration. Set NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD"
    );
  }
  return cfg;
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  logger.info(`Tool called: ${name}`);

  const neoCfg = getNeo4jConfig();
  const driver = await getDriver(neoCfg);

  try {
    switch (name) {
      case "scan": {
        const roots = (args?.paths as string[] | undefined) ?? [process.cwd()];
        const watch = Boolean(args?.watch ?? false);
        const includeGlobs = (args?.includeGlobs as string[] | undefined) ?? [];
        const excludeGlobs = (args?.excludeGlobs as string[] | undefined) ?? [];

        const start = Date.now();
        const snapshotVersion = new Date().toISOString();

        // 1) Gather files per repo using globs
        const repoFiles = await scanRepositories(roots, {
          includeGlobs,
          excludeGlobs,
        });

        // 2) Parse & extract entities per file using Tree-sitter (+ Repository nodes)
        const repoEntities = repoFiles.map((r) =>
          makeRepositoryEntity(r.repoRoot)
        );
        const extracted = await extractEntities(repoFiles);
        const depEntities = await extractDependencies(roots);
        const allEntities = [...repoEntities, ...extracted, ...depEntities];

        // 3) Build relationships between extracted entities
        const allRelationships = buildRelationships(allEntities);

        // 4) Persist nodes and relationships in Neo4j (versioned)
        await upsertEntitiesBatch(driver, allEntities, snapshotVersion);
        await upsertRelationshipsBatch(
          driver,
          allRelationships,
          snapshotVersion
        );

        const ms = Date.now() - start;

        // 5) Optional: enable file watcher for incremental updates
        let watchMsg = "";
        if (watch) {
          const { startIncrementalWatcher } = await import(
            "./scanner/incrementalWatcher.js"
          );
          startIncrementalWatcher(
            roots,
            includeGlobs,
            excludeGlobs,
            async (delta) => {
              const repoEntitiesDelta = delta.map((r) =>
                makeRepositoryEntity(r.repoRoot)
              );
              const updatedEntities = await extractEntities(delta);
              const merged = [...repoEntitiesDelta, ...updatedEntities];
              const updatedRels = buildRelationships(merged);
              const sv = new Date().toISOString();
              await upsertEntitiesBatch(driver, merged, sv);
              await upsertRelationshipsBatch(driver, updatedRels, sv);
            }
          );
          watchMsg = "\nWatching for incremental changes (chokidar enabled).";
        }

        const summary =
          `Scan complete in ${ms}ms\n` +
          `Repositories: ${roots.length}\n` +
          `Files scanned: ${repoFiles.reduce(
            (s, r) => s + r.files.length,
            0
          )}\n` +
          `Entities: ${allEntities.length}\n` +
          `Relationships: ${allRelationships.length}${watchMsg}`;

        return { content: [{ type: "text", text: summary }] };
      }

      case "impact": {
        const file = String(args?.file);
        const repoRoot = (args?.repoRoot as string) || process.cwd();
        const depth =
          typeof args?.depth === "number" ? (args?.depth as number) : 3;

        const result = await runImpactAnalysis(driver, {
          file,
          repoRoot,
          depth,
        });
        return { content: [{ type: "text", text: result }] };
      }

      case "query": {
        const prompt = String(args?.prompt);
        const limit =
          typeof args?.limit === "number" ? (args?.limit as number) : 100;

        // Initialize neo4j MCP client and use it instead of direct driver
        const mcpClient = await initializeNeo4jMcpClient();
        const text = await runNaturalLanguageQuery(mcpClient, {
          prompt,
          limit,
        });
        return { content: [{ type: "text", text }] };
      }

      case "learn": {
        const text = await runLearn(driver);
        return { content: [{ type: "text", text }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    logger.error(`Tool ${name} failed`, err);
    return {
      content: [
        {
          type: "text",
          text:
            "Error: " +
            (err instanceof Error ? err.message : JSON.stringify(err)),
        },
      ],
    };
  } finally {
    // Note: keep driver open for reuse during session
  }
});

// Startup
async function main() {
  try {
    logger.info("Starting MCP Code Relationship Navigator server...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("Server started on stdio.");
  } catch (e) {
    logger.error("Startup failed", e);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
