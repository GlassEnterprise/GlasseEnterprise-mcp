// Minimal Neo4j Aura connection test
const neo4j = require("neo4j-driver");

const uri = "bolt+s://eba9e1fd.databases.neo4j.io:7687";
const user = "neo4j";
const password = "mqi6XxaE23LVbTHpo3P1uB_h0_RqwjXD9X1WGZCpY98";

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
  connectionTimeout: 8000,
});

async function testConnection() {
  const session = driver.session({ database: "neo4j" });
  try {
    const result = await session.run("RETURN 1 as ok");
    console.log("Neo4j connection successful:", result.records[0].get("ok"));
  } catch (err) {
    console.error("Neo4j connection failed:", err);
  } finally {
    await session.close();
    await driver.close();
  }
}

testConnection();
