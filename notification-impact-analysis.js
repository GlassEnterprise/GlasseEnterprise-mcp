import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
config({ path: resolve(__dirname, ".env") });

async function analyzeNotificationImpact() {
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
    console.log("=== NOTIFICATION POST REQUEST IMPACT ANALYSIS ===\n");

    // 1. Find POST notification APIs and their providers
    console.log("1. POST NOTIFICATION API PROVIDERS:\n");
    const postNotificationQuery = `
      MATCH (api:API)
      WHERE api.method = 'POST' 
        AND (toLower(api.name) CONTAINS 'notification' 
             OR toLower(api.url) CONTAINS 'notification' 
             OR toLower(api.path) CONTAINS 'notification')
      MATCH (repo:Repository)-[:REPO_PROVIDES_API]->(api)
      RETURN api.name, api.path, api.url, api.responseType, api.file, repo.name as repoName, repo.repoRoot
    `;

    const postNotificationResult = await session.run(postNotificationQuery);
    const postNotificationAPIs = [];

    postNotificationResult.records.forEach((record, index) => {
      const apiInfo = {
        name: record.get("api.name") || "N/A",
        path: record.get("api.path") || "N/A",
        url: record.get("api.url") || "N/A",
        responseType: record.get("api.responseType") || "N/A",
        file: record.get("api.file") || "N/A",
        repoName: record.get("repoName") || "N/A",
        repoRoot: record.get("repo.repoRoot") || "N/A",
      };
      postNotificationAPIs.push(apiInfo);

      console.log(`${index + 1}. ${apiInfo.name}`);
      console.log(`   Repository: ${apiInfo.repoName}`);
      console.log(`   Path: ${apiInfo.path}`);
      console.log(`   URL: ${apiInfo.url}`);
      console.log(`   Response Type: ${apiInfo.responseType}`);
      console.log(`   File: ${apiInfo.file}`);
      console.log(`   Repo Path: ${apiInfo.repoRoot}`);
      console.log("");
    });

    // 2. Find consumers of notification APIs
    console.log("2. REPOSITORIES CONSUMING NOTIFICATION APIs:\n");
    const consumerQuery = `
      MATCH (consumerRepo:Repository)-[consumes:CONSUMES_API_FROM]->(providerRepo:Repository)
      MATCH (providerRepo)-[:REPO_PROVIDES_API]->(api:API)
      WHERE toLower(api.name) CONTAINS 'notification' 
         OR toLower(api.url) CONTAINS 'notification' 
         OR toLower(api.path) CONTAINS 'notification'
      RETURN DISTINCT consumerRepo.name as consumer, consumerRepo.repoRoot as consumerPath,
                      providerRepo.name as provider, providerRepo.repoRoot as providerPath,
                      consumes.consumedAPI, consumes.providedAPI, consumes.matchConfidence,
                      api.name as apiName, api.method, api.path as apiPath
    `;

    const consumerResult = await session.run(consumerQuery);
    const consumerRelationships = [];

    consumerResult.records.forEach((record, index) => {
      const relationship = {
        consumer: record.get("consumer") || "N/A",
        consumerPath: record.get("consumerPath") || "N/A",
        provider: record.get("provider") || "N/A",
        providerPath: record.get("providerPath") || "N/A",
        consumedAPI: record.get("consumes.consumedAPI") || "N/A",
        providedAPI: record.get("consumes.providedAPI") || "N/A",
        confidence: record.get("consumes.matchConfidence") || "N/A",
        apiName: record.get("apiName") || "N/A",
        method: record.get("api.method") || "N/A",
        apiPath: record.get("apiPath") || "N/A",
      };
      consumerRelationships.push(relationship);

      console.log(
        `${index + 1}. ${relationship.consumer} → ${relationship.provider}`
      );
      console.log(`   API: ${relationship.method} ${relationship.apiName}`);
      console.log(`   Path: ${relationship.apiPath}`);
      console.log(`   Consumer Path: ${relationship.consumerPath}`);
      console.log(`   Provider Path: ${relationship.providerPath}`);
      console.log(`   Confidence: ${relationship.confidence}`);
      console.log("");
    });

    // 3. Find functions that interact with notification APIs
    console.log("3. FUNCTIONS INTERACTING WITH NOTIFICATION APIs:\n");
    const functionQuery = `
      MATCH (f:Function)-[:PROVIDES_API|USES_API]->(api:API)
      WHERE toLower(api.name) CONTAINS 'notification' 
         OR toLower(api.url) CONTAINS 'notification' 
         OR toLower(api.path) CONTAINS 'notification'
      MATCH (file:File)-[:CONTAINS]->(f)
      RETURN f.name as functionName, f.file as functionFile, f.repoRoot,
             api.name as apiName, api.method, api.path as apiPath,
             file.name as fileName,
             CASE WHEN EXISTS((f)-[:PROVIDES_API]->(api)) THEN 'PROVIDES'
                  WHEN EXISTS((f)-[:USES_API]->(api)) THEN 'USES' 
                  ELSE 'UNKNOWN' END as relationship
      ORDER BY f.repoRoot, api.method, api.name
    `;

    const functionResult = await session.run(functionQuery);
    const functionInteractions = [];

    functionResult.records.forEach((record, index) => {
      const interaction = {
        functionName: record.get("functionName") || "N/A",
        functionFile: record.get("functionFile") || "N/A",
        repoRoot: record.get("f.repoRoot") || "N/A",
        apiName: record.get("apiName") || "N/A",
        method: record.get("api.method") || "N/A",
        apiPath: record.get("apiPath") || "N/A",
        fileName: record.get("fileName") || "N/A",
        relationship: record.get("relationship") || "N/A",
      };
      functionInteractions.push(interaction);

      console.log(
        `${index + 1}. Function: ${interaction.functionName} (${
          interaction.relationship
        })`
      );
      console.log(`   API: ${interaction.method} ${interaction.apiName}`);
      console.log(`   Path: ${interaction.apiPath}`);
      console.log(`   File: ${interaction.fileName}`);
      console.log(`   Function File: ${interaction.functionFile}`);
      console.log(`   Repository: ${interaction.repoRoot}`);
      console.log("");
    });

    // 4. Find shared packages between notification-related repos
    console.log("4. PACKAGE DEPENDENCIES THAT COULD BE AFFECTED:\n");
    const packageQuery = `
      MATCH (repo:Repository)
      WHERE EXISTS {
        MATCH (repo)-[:REPO_PROVIDES_API]->(api:API)
        WHERE toLower(api.name) CONTAINS 'notification' 
           OR toLower(api.url) CONTAINS 'notification' 
           OR toLower(api.path) CONTAINS 'notification'
      }
      MATCH (repo)-[:REPO_DEPENDS_ON_PACKAGE]->(pkg:Package)
      MATCH (otherRepo:Repository)-[:REPO_DEPENDS_ON_PACKAGE]->(pkg)
      WHERE repo <> otherRepo
      RETURN pkg.name as packageName, 
             collect(DISTINCT repo.name) as notificationRepos,
             collect(DISTINCT otherRepo.name) as otherRepos
      ORDER BY packageName
    `;

    const packageResult = await session.run(packageQuery);

    packageResult.records.forEach((record, index) => {
      const packageName = record.get("packageName") || "N/A";
      const notificationRepos = record.get("notificationRepos") || [];
      const otherRepos = record.get("otherRepos") || [];

      console.log(`${index + 1}. Package: ${packageName}`);
      console.log(
        `   Used by notification repos: ${notificationRepos.join(", ")}`
      );
      console.log(`   Also used by: ${otherRepos.join(", ")}`);
      console.log("");
    });

    // 5. Generate Impact Summary
    console.log("=== IMPACT ANALYSIS SUMMARY ===\n");

    console.log(
      "REPOSITORIES DIRECTLY AFFECTED BY POST NOTIFICATION CONTRACT CHANGES:\n"
    );
    const affectedRepos = new Set();

    // Add providers of POST notification APIs
    postNotificationAPIs.forEach((api) => {
      affectedRepos.add(`${api.repoName} (${api.repoRoot})`);
      console.log(`• ${api.repoName} - Provides ${api.name} API`);
    });

    // Add consumers
    consumerRelationships.forEach((rel) => {
      if (rel.method === "POST") {
        affectedRepos.add(`${rel.consumer} (${rel.consumerPath})`);
        console.log(
          `• ${rel.consumer} - Consumes POST notification API from ${rel.provider}`
        );
      }
    });

    console.log(`\nTOTAL AFFECTED REPOSITORIES: ${affectedRepos.size}\n`);

    console.log("RECOMMENDED IMPACT ANALYSIS ACTIONS:\n");
    console.log(
      "1. Review POST notification request/response contracts in provider repositories"
    );
    console.log(
      "2. Update consumer repositories to handle new contract format"
    );
    console.log("3. Test integration between affected repositories");
    console.log("4. Update API documentation and schemas");
    console.log("5. Consider versioning strategy for backward compatibility");
    console.log(
      "6. Check shared package dependencies for contract-related utilities"
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

analyzeNotificationImpact().catch(console.error);
