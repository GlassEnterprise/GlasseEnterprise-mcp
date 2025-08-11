# Hello World MCP

A minimal MCP server in JavaScript for the MCP hackathon with Cillers. Exposes a simple tool that returns "Hello World".

## Features

- Simple HTTP server using Node.js
- MCP tool endpoint: `/tool/hello` (GET) returns `{ "message": "Hello World" }`
- MCP tool endpoint: `/tool/time` (GET) returns `{ "time": "<current ISO time>" }`

## Getting Started

1. **Install dependencies** (if any are added in the future):

   ```bash
   npm install
   ```

2. **Run the server:**

   ```bash
   npm start
   ```

   The server will start on port 3000 by default.

3. **Test the MCP tools:**

   - Hello World tool:

     ```
     curl http://localhost:3000/tool/hello
     ```

     Response:

     ```json
     { "message": "Hello World" }
     ```

   - Time Now tool:

     ```
     curl http://localhost:3000/tool/time
     ```

     Response:

     ```json
     { "time": "2025-11-08T09:36:40.000Z" }
     ```

## Configuration

You can configure the MCP server using environment variables:

- `PORT`: Set the port for the server (default: 3000)

Example:

```bash
PORT=4000 npm start
```

## Cline Integration

To add this MCP to Cline, register it in your Cline MCP servers configuration. Example (servers.json):

```json
{
  "servers": [
    {
      "name": "hello-world-mcp",
      "command": "node /absolute/path/to/MCP/hello-world-mcp/build/index.js",
      "description": "Minimal MCP server for hackathon"
    }
  ]
}
```

Replace `/absolute/path/to/` with the actual path on your system.

## Project Structure

- `src/index.js` — Main server file

## License

MIT
