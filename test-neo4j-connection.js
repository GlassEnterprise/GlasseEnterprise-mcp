import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
config({ path: resolve(__dirname, ".env") });

async function testConnection() {
  console.log("Testing Neo4j connection...");
  console.log("URI:", process.env.NEO4J_URI);
  console.log("Username:", process.env.NEO4J_USERNAME);
  console.log("Database:", process.env.NEO4J_DATABASE);
  console.log(
    "Trust All Certificates:",
    process.env.NEO4J_TRUST_ALL_CERTIFICATES
  );

  const driverConfig = {
    connectionTimeout: 8000,
    maxConnectionPoolSize: 50,
  };

  // Configure SSL/TLS settings - convert URL scheme to config-based approach
  let uri = process.env.NEO4J_URI;

  // If URI has encryption scheme, convert to bolt:// and configure encryption via config
  if (uri.includes("+s") || uri.includes("bolt+s") || uri.includes("neo4j+s")) {
    // Remove encryption from URL and configure it via driver config instead
    uri = uri
      .replace(/bolt\+s:\/\//, "bolt://")
      .replace(/neo4j\+s:\/\//, "bolt://");
    driverConfig.encrypted = "ENCRYPTION_ON";

    if (process.env.NEO4J_TRUST_ALL_CERTIFICATES === "true") {
      driverConfig.trust = "TRUST_ALL_CERTIFICATES";
      console.log("Using TRUST_ALL_CERTIFICATES for SSL");
    } else {
      driverConfig.trust = "TRUST_SYSTEM_CA_SIGNED_CERTIFICATES";
      console.log("Using TRUST_SYSTEM_CA_SIGNED_CERTIFICATES for SSL");
    }
    console.log("Converted URI from encrypted scheme to:", uri);
  }

  console.log("Driver config:", JSON.stringify(driverConfig, null, 2));

  const auth = neo4j.auth.basic(
    process.env.NEO4J_USERNAME,
    process.env.NEO4J_PASSWORD
  );

  let driver;
  try {
    driver = neo4j.driver(uri, auth, driverConfig);
    console.log("Driver created successfully");

    const session = driver.session({ database: process.env.NEO4J_DATABASE });
    try {
      console.log("Testing connectivity...");
      const result = await session.run("RETURN 'Hello, Neo4j!' as message");
      const message = result.records[0].get("message");
      console.log("✅ Connection successful! Message:", message);

      // Test a simple query
      console.log("Testing database info query...");
      const infoResult = await session.run(
        "CALL dbms.components() YIELD name, versions, edition"
      );
      const info = infoResult.records.map((record) => ({
        name: record.get("name"),
        versions: record.get("versions"),
        edition: record.get("edition"),
      }));
      console.log("✅ Database info:", JSON.stringify(info, null, 2));

      console.log(
        "\n🎉 All tests passed! Neo4j connection is working correctly."
      );
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error("❌ Connection failed:", error.message);
    console.error("Full error:", error);
    return false;
  } finally {
    if (driver) {
      await driver.close();
    }
  }

  return true;
}

testConnection()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    console.error("Test failed:", error);
    process.exit(1);
  });
