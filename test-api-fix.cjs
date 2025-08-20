const { extractEntities } = require("./build/scanner/astExtractor.js");

// Test JavaScript code with API variables and calls
const testCode = `
// API configuration variables (should NOT be detected as APIs)
const API_BASE_URL = "https://api.example.com";
const BASE_URL = "https://backend.service.com";
const ENDPOINT_URL = "/api/v1";

// Actual API calls (should be detected as consumed APIs)
function fetchUsers() {
  return axios.get(API_BASE_URL + "/users");
}

function createUser(userData) {
  return axios.post(\`\${BASE_URL}/users\`, userData);
}

function updateUser(id, data) {
  return axios.put(BASE_URL + "/users/" + id, data);
}

// Server-side route definitions (should be detected as provided APIs)
const express = require('express');
const app = express();

app.get('/api/users', (req, res) => {
  res.json({ users: [] });
});

app.post('/api/users', (req, res) => {
  res.json({ success: true });
});
`;

async function testAPIFix() {
  console.log("🧪 Testing Enhanced API Detection...\n");

  const testRepo = {
    repoRoot: "/test/repo",
    files: [
      {
        relPath: "src/api/service.js",
        absPath: "/test/repo/src/api/service.js",
        language: "javascript",
        content: testCode,
      },
    ],
  };

  try {
    const entities = await extractEntities([testRepo]);
    
    console.log(`✅ Total entities extracted: ${entities.length}\n`);

    // Filter API entities
    const apis = entities.filter(e => e.type === "API");
    console.log(`🔍 API entities found: ${apis.length}`);
    
    const consumedAPIs = apis.filter(api => api.direction === "consumed");
    const providedAPIs = apis.filter(api => api.direction === "provided");
    
    console.log(`\n📤 Consumed APIs (${consumedAPIs.length}):`);
    consumedAPIs.forEach(api => {
      console.log(`  - ${api.method} ${api.url || api.path}`);
    });
    
    console.log(`\n📥 Provided APIs (${providedAPIs.length}):`);
    providedAPIs.forEach(api => {
      console.log(`  - ${api.method} ${api.path || api.url}`);
    });

    // Filter Variable entities
    const variables = entities.filter(e => e.type === "Variable");
    console.log(`\n📋 Variables found: ${variables.length}`);
    variables.forEach(variable => {
      console.log(`  - ${variable.name}`);
    });

    console.log("\n✨ API detection test completed!");
    
    // Verify the fix worked
    const hasConsumedAPIs = consumedAPIs.length > 0;
    const hasProvidedAPIs = providedAPIs.length > 0;
    const hasVariables = variables.length > 0;
    
    if (hasConsumedAPIs && hasProvidedAPIs && hasVariables) {
      console.log("🎉 SUCCESS: Scanner correctly distinguishes between variables and API calls!");
    } else {
      console.log("❌ ISSUE: Scanner may still have classification problems");
    }
    
  } catch (error) {
    console.error("❌ Test failed:", error);
  }
}

testAPIFix();
