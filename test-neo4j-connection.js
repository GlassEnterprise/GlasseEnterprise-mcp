/**
 * ESM-compatible Neo4j connectivity test using the same env as the MCP server.
 * Loads .env and runs RETURN 1. Uses secure TLS by default.
 */
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { config as dotenvConfig } from "dotenv";
import neo4j from "neo4j-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env beside this script
dotenvConfig({ path: resolve(__dirname, ".env") });

const uri = process.env.NEO4J_URI || "bolt://localhost:7687";
const user = process.env.NEO4J_USERNAME || "neo4j";
const password = process.env.NEO4J_PASSWORD || "password";
const database = process.env.NEO4J_DATABASE || "neo4j";

console.log("Testing Neo4j connection with settings:");
console.log("NEO4J_URI =", uri);
console.log("NEO4J_USERNAME =", user);
console.log("NEO4J_DATABASE =", database);
console.log(
  "NODE_TLS_REJECT_UNAUTHORIZED =",
  process.env.NODE_TLS_REJECT_UNAUTHORIZED
);

// Attempt both direct and secure schemes, similar to runtime fallback logic
const candidates = [
  uri,
  uri
    .replace(/^neo4j\+s(sc)?:\/\//, "bolt+ssc://")
    .replace(/^bolt\+s(sc)?:\/\//, "bolt+ssc://")
    .replace(/^neo4j:\/\//, "bolt+ssc://"),
  uri
    .replace(/^neo4j\+s(sc)?:\/\//, "bolt+s://")
    .replace(/^neo4j:\/\//, "bolt+s://"),
  uri
    .replace(/^neo4j\+s(sc)?:\/\//, "bolt://")
    .replace(/^bolt\+s(sc)?:\/\//, "bolt://")
    .replace(/^neo4j:\/\//, "bolt://"),
].filter((v, i, a) => !!v && a.indexOf(v) === i);

let lastErr;

for (const candidate of candidates) {
  console.log("\nTrying:", candidate);
  const driver = neo4j.driver(candidate, neo4j.auth.basic(user, password), {
    // Fail fast on bad network/TLS instead of hanging and triggering MCP timeouts
    connectionTimeout: 8000,
    // Be conservative on pool size to avoid resource spikes during tests
    maxConnectionPoolSize: 10,
  });

  const session = driver.session({ database });

  try {
    const res = await session.run("RETURN 1 as ok", {}, { timeout: 8000 });
    const ok = res.records[0].get("ok");
    console.log("SUCCESS: RETURN 1 ->", ok && ok.toInt ? ok.toInt() : ok);
    await session.close();
    await driver.close();
    process.exit(0);
  } catch (e) {
    lastErr = e;
    console.error("FAILED:", e && e.message ? e.message : e);
    try {
      await session.close();
    } catch {}
    try {
      await driver.close();
    } catch {}
  }
}

console.error(
  "\nAll candidates failed. Last error:",
  lastErr && lastErr.message ? lastErr.message : lastErr
);
process.exit(1);
