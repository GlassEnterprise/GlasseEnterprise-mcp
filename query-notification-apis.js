import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
config({ path: resolve(__dirname, ".env") });

async function queryNotificationAPIs() {
  const driverConfig = {
    connectionTimeout: 8000,
    maxConnectionPoolSize: 50,
  };

  let uri = process.env.NEO4J_URI;
  if (uri.includes("+s")) {
    uri = uri
      .replace(/bolt\+s:\/\//, "bolt://")
      .replace(/neo4j\+s:\/\//, "bolt://");
    driverConfig.encrypted = "ENCRYPTION_ON";
    driverConfig.trust = "TRUST_ALL_CERTIFICATES";
  }

  const auth = neo4j.auth.basic(
    process.env.NEO4J_USERNAME,
    process.env.NEO4J_PASSWORD
  );

  const driver = neo4j.driver(uri, auth, driverConfig);
  const session = driver.session({ database: process.env.NEO4J_DATABASE });

  try {
    console.log("=== SEARCHING FOR NOTIFICATION-RELATED APIs ===\n");

    // 1. Find all notification-related APIs
    const notificationQuery = `
      MATCH (api:API)
      WHERE toLower(api.name) CONTAINS 'notification' 
         OR toLower(api.url) CONTAINS 'notification' 
         OR toLower(api.path) CONTAINS 'notification'
         OR toLower(api.name) CONTAINS 'notify'
      RETURN api.name, api.method, api.url, api.path, api.responseType, api.file, api.repoRoot
      ORDER BY api.method, api.name
    `;

    const notificationResult = await session.run(notificationQuery);

    if (notificationResult.records.length > 0) {
      console.log(
        `Found ${notificationResult.records.length} notification-related APIs:\n`
      );
      notificationResult.records.forEach((record, index) => {
        console.log(`${index + 1}. API: ${record.get("api.name") || "N/A"}`);
        console.log(`   Method: ${record.get("api.method") || "N/A"}`);
        console.log(`   URL: ${record.get("api.url") || "N/A"}`);
        console.log(`   Path: ${record.get("api.path") || "N/A"}`);
        console.log(
          `   Response Type: ${record.get("api.responseType") || "N/A"}`
        );
        console.log(`   File: ${record.get("api.file") || "N/A"}`);
        console.log(`   Repository: ${record.get("api.repoRoot") || "N/A"}`);
        console.log("");
      });
    } else {
      console.log(
        "No notification-specific APIs found. Let me search more broadly...\n"
      );

      // 2. Search for POST APIs that might be notifications
      const postQuery = `
        MATCH (api:API)
        WHERE api.method = 'POST'
        RETURN api.name, api.method, api.url, api.path, api.responseType, api.file, api.repoRoot
        ORDER BY api.name
        LIMIT 20
      `;

      const postResult = await session.run(postQuery);
      console.log(
        `Found ${postResult.records.length} POST APIs (showing first 20):\n`
      );
      postResult.records.forEach((record, index) => {
        console.log(`${index + 1}. API: ${record.get("api.name") || "N/A"}`);
        console.log(`   Method: ${record.get("api.method") || "N/A"}`);
        console.log(`   URL: ${record.get("api.url") || "N/A"}`);
        console.log(`   Path: ${record.get("api.path") || "N/A"}`);
        console.log(`   File: ${record.get("api.file") || "N/A"}`);
        console.log(`   Repository: ${record.get("api.repoRoot") || "N/A"}`);
        console.log("");
      });
    }

    // 3. Get repository summary
    console.log("\n=== REPOSITORY SUMMARY ===\n");
    const repoQuery = `
      MATCH (r:Repository)
      OPTIONAL MATCH (r)-[:REPO_PROVIDES_API]->(api:API)
      RETURN r.name, r.repoRoot, count(api) as apiCount
      ORDER BY apiCount DESC
    `;

    const repoResult = await session.run(repoQuery);
    console.log("Repositories with API counts:");
    repoResult.records.forEach((record, index) => {
      console.log(
        `${index + 1}. ${record.get("r.name") || "N/A"} (${record.get(
          "apiCount"
        )} APIs)`
      );
      console.log(`   Path: ${record.get("r.repoRoot") || "N/A"}`);
    });

    // 4. Find API consumers and dependencies
    console.log("\n=== API CONSUMPTION RELATIONSHIPS ===\n");
    const consumptionQuery = `
      MATCH (repo1:Repository)-[r:CONSUMES_API_FROM]->(repo2:Repository)
      RETURN repo1.name as consumer, repo2.name as provider, r.consumedAPI, r.providedAPI, r.matchConfidence
      ORDER BY r.matchConfidence DESC
      LIMIT 10
    `;

    const consumptionResult = await session.run(consumptionQuery);
    if (consumptionResult.records.length > 0) {
      console.log("API consumption relationships:");
      consumptionResult.records.forEach((record, index) => {
        console.log(
          `${index + 1}. ${record.get("consumer")} consumes from ${record.get(
            "provider"
          )}`
        );
        console.log(`   Consumed API: ${record.get("r.consumedAPI") || "N/A"}`);
        console.log(`   Provided API: ${record.get("r.providedAPI") || "N/A"}`);
        console.log(
          `   Confidence: ${record.get("r.matchConfidence") || "N/A"}`
        );
        console.log("");
      });
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

queryNotificationAPIs().catch(console.error);
