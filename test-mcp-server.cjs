const { spawn } = require('child_process');
const path = require('path');

// Spawn the MCP server
const serverPath = path.join(__dirname, 'build', 'index.js');
const mcp = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let responseBuffer = '';

// Handle server output
mcp.stdout.on('data', (data) => {
  responseBuffer += data.toString();
  
  // Try to parse complete JSON responses
  const lines = responseBuffer.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const json = JSON.parse(line);
        if (json.jsonrpc) {
          console.log('Response:', JSON.stringify(json, null, 2));
        }
      } catch (e) {
        // Not JSON, likely a log message
      }
    }
  }
  responseBuffer = lines[lines.length - 1];
});

mcp.stderr.on('data', (data) => {
  console.error('Server error:', data.toString());
});

mcp.on('close', (code) => {
  console.log(`Server exited with code ${code}`);
});

// Test sequence
async function runTests() {
  console.log('Testing MCP Server...\n');
  
  // Test 1: List tools
  console.log('Test 1: Listing available tools');
  const listToolsRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list'
  };
  mcp.stdin.write(JSON.stringify(listToolsRequest) + '\n');
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Test 2: Run learn command
  console.log('\nTest 2: Running learn command');
  const learnRequest = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'learn',
      arguments: {}
    }
  };
  mcp.stdin.write(JSON.stringify(learnRequest) + '\n');
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Test 3: Query with simple Cypher
  console.log('\nTest 3: Running query with Cypher');
  const queryRequest = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'query',
      arguments: {
        prompt: 'CYPHER: RETURN 1 AS test',
        limit: 10
      }
    }
  };
  mcp.stdin.write(JSON.stringify(queryRequest) + '\n');
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Test 4: Small scan
  console.log('\nTest 4: Scanning a small directory');
  const scanRequest = {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'scan',
      arguments: {
        paths: ['./src/utils'],
        watch: false,
        includeGlobs: ['*.ts'],
        excludeGlobs: []
      }
    }
  };
  mcp.stdin.write(JSON.stringify(scanRequest) + '\n');
  
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Close the server
  console.log('\nTests complete. Closing server...');
  mcp.stdin.end();
}

// Run the tests
runTests().catch(console.error);
