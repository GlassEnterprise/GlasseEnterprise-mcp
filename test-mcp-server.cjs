const { spawn } = require('child_process');
const path = require('path');

/**
 * Simple MCP stdio client for local testing.
 * Uses LSP-style framing with "Content-Length" headers and JSON-RPC 2.0 payloads.
 */

const serverPath = path.join(__dirname, 'build', 'index.js');
const mcp = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let nextId = 1;
const mkId = () => nextId++;

/**
 * Write a JSON-RPC message with Content-Length framing.
 */
function writeMessage(msg) {
  const json = JSON.stringify(msg);
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  mcp.stdin.write(header);
  mcp.stdin.write(body);
}

let stdoutBuf = Buffer.alloc(0);

mcp.stdout.on('data', (chunk) => {
  stdoutBuf = Buffer.concat([stdoutBuf, chunk]);

  while (true) {
    // Support both CRLF and LF header delimiters
    let headerEnd = stdoutBuf.indexOf('\r\n\r\n');
    let delimLen = 4;
    if (headerEnd === -1) {
      headerEnd = stdoutBuf.indexOf('\n\n');
      delimLen = headerEnd === -1 ? -1 : 2;
    }
    if (headerEnd === -1) break;

    const headerStr = stdoutBuf.slice(0, headerEnd).toString('utf8');
    const lenMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!lenMatch) {
      // Drop malformed header
      stdoutBuf = stdoutBuf.slice(headerEnd + delimLen);
      continue;
    }

    const contentLength = parseInt(lenMatch[1], 10);
    const totalNeeded = headerEnd + delimLen + contentLength;
    if (stdoutBuf.length < totalNeeded) break;

    const body = stdoutBuf.slice(headerEnd + delimLen, totalNeeded).toString('utf8');
    stdoutBuf = stdoutBuf.slice(totalNeeded);

    try {
      const msg = JSON.parse(body);
      console.log('Response:', JSON.stringify(msg, null, 2));
    } catch (e) {
      console.error('Parse error:', e?.message || e, '\nBody:', body);
    }
  }
});

mcp.stderr.on('data', (data) => {
  // Server logs should go to stderr; we surface them here
  process.stderr.write(data);
});

mcp.on('close', (code) => {
  console.log(`Server exited with code ${code}`);
});

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTests() {
  console.log('Testing MCP Server with proper stdio framing...\n');

  // Give the server a moment to boot
  await sleep(200);

  // 1) initialize handshake
  const initId = mkId();
  console.log('Test 1: initialize');
  writeMessage({
    jsonrpc: '2.0',
    id: initId,
    method: 'initialize',
    params: {
      protocolVersion: '0.5.0',
      capabilities: {},
      clientInfo: { name: 'local-test', version: '0.1.0' }
    }
  });

  await sleep(500);

  // Send initialized notification (optional)
  writeMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {}
  });

  // 2) tools/list
  const listId = mkId();
  console.log('\nTest 2: tools/list');
  writeMessage({
    jsonrpc: '2.0',
    id: listId,
    method: 'tools/list'
  });

  await sleep(500);

  // 3) tools/call: learn
  const learnId = mkId();
  console.log('\nTest 3: tools/call learn');
  writeMessage({
    jsonrpc: '2.0',
    id: learnId,
    method: 'tools/call',
    params: {
      name: 'learn',
      arguments: {}
    }
  });

  await sleep(1000);

  // 4) tools/call: query
  const queryId = mkId();
  console.log('\nTest 4: tools/call query (simple CYPHER)');
  writeMessage({
    jsonrpc: '2.0',
    id: queryId,
    method: 'tools/call',
    params: {
      name: 'query',
      arguments: {
        prompt: 'CYPHER: RETURN 1 AS test',
        limit: 10
      }
    }
  });

  await sleep(1000);

  // 5) tools/call: scan
  const scanId = mkId();
  console.log('\nTest 5: tools/call scan (small directory)');
  writeMessage({
    jsonrpc: '2.0',
    id: scanId,
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
  });

  await sleep(3000);

  console.log('\nTests complete. Terminating server process...');
  // Gracefully end by closing stdin; if the SDK keeps running, fall back to kill.
  try {
    mcp.stdin.end();
  } catch {}
  // Ensure exit eventually
  setTimeout(() => {
    try {
      mcp.kill();
    } catch {}
  }, 1000);
}

runTests().catch((err) => {
  console.error('Test harness error:', err);
  try { mcp.kill(); } catch {}
});
