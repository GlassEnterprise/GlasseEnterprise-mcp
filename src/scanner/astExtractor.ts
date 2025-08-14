/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "crypto";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScriptLang from "tree-sitter-typescript";
import Python from "tree-sitter-python";
import Java from "tree-sitter-java";
import CSharp from "tree-sitter-c-sharp";

import {
  AnyEntity,
  APIEntity,
  ClassEntity,
  ConfigEntity,
  DatabaseColumnEntity,
  DatabaseTableEntity,
  ErrorMessageEntity,
  FileEntity,
  FunctionEntity,
  LanguageId,
  RepoFiles,
  RepositoryEntity,
  TestEntity,
  VariableEntity,
} from "./types.js";
import { Logger } from "../utils/logger.js";

const logger = new Logger("AstExtractor");

type LangModule = any;

function langModuleFor(language: LanguageId): LangModule | null {
  switch (language) {
    case "javascript":
      return JavaScript as unknown as LangModule;
    case "typescript":
      // tree-sitter-typescript exports { typescript, tsx }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return (TypeScriptLang as any).typescript ?? TypeScriptLang;
    case "python":
      return Python as unknown as LangModule;
    case "java":
      return Java as unknown as LangModule;
    case "csharp":
      return CSharp as unknown as LangModule;
    default:
      return null;
  }
}

function stableId(parts: string[]): string {
  return createHash("md5").update(parts.join("|")).digest("hex");
}

// Normalize paths/URLs for stable API identity (deduplication)
// - For full URLs, strip protocol/host and use pathname
// - Remove query/hash, collapse slashes, ensure leading '/', drop trailing '/' (except root)
function normalizePathForId(path: string): string {
  try {
    let p = path.trim();
    if (/^https?:\/\//i.test(p) || /^\/\//.test(p)) {
      try {
        const u = new URL(p.startsWith("//") ? "http:" + p : p);
        p = u.pathname;
      } catch {
        // keep as-is on URL parse failure
      }
    }
    p = p.split("?")[0].split("#")[0];
    if (!p.startsWith("/")) p = "/" + p;
    p = p.replace(/\/{2,}/g, "/");
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return p;
  } catch {
    return path;
  }
}

function normalizeUrlForId(urlOrPath: string): string {
  return normalizePathForId(urlOrPath);
}

// Remove template literal placeholders like `${BASE_URL}` so paths normalize/match
function stripTemplatePlaceholders(input: string): string {
  try {
    return input.replace(/\$\{[^}]+\}/g, "");
  } catch {
    return input;
  }
}

function makeFileEntity(
  repoRoot: string,
  relPath: string,
  size?: number
): FileEntity {
  return {
    id: stableId([repoRoot, "File", relPath]),
    type: "File",
    name: relPath.split(/[\\/]/).pop() || relPath,
    repoRoot,
    file: relPath,
    meta: size != null ? { size } : undefined,
  };
}

function makeFunctionEntity(
  repoRoot: string,
  relPath: string,
  language: LanguageId | "unknown",
  name: string,
  startLine: number,
  endLine: number
): FunctionEntity {
  return {
    id: stableId([
      repoRoot,
      "Function",
      relPath,
      name,
      String(startLine),
      String(endLine),
    ]),
    type: "Function",
    name,
    repoRoot,
    file: relPath,
    language,
    span: { startLine, endLine },
  };
}

function makeClassEntity(
  repoRoot: string,
  relPath: string,
  language: LanguageId | "unknown",
  name: string,
  startLine: number,
  endLine: number
): ClassEntity {
  return {
    id: stableId([
      repoRoot,
      "Class",
      relPath,
      name,
      String(startLine),
      String(endLine),
    ]),
    type: "Class",
    name,
    repoRoot,
    file: relPath,
    language,
    span: { startLine, endLine },
  };
}

function makeVariableEntity(
  repoRoot: string,
  relPath: string,
  language: LanguageId | "unknown",
  name: string,
  startLine: number,
  endLine: number
): VariableEntity {
  return {
    id: stableId([
      repoRoot,
      "Variable",
      relPath,
      name,
      String(startLine),
      String(endLine),
    ]),
    type: "Variable",
    name,
    repoRoot,
    file: relPath,
    language,
    span: { startLine, endLine },
  };
}

function makeAPIEntityProvided(
  repoRoot: string,
  relPath: string,
  method: string,
  path: string
): APIEntity {
  const methodNorm = method.toUpperCase();
  const pathKey = normalizePathForId(path);
  const name = `${methodNorm} ${path}`;
  return {
    id: stableId([repoRoot, "API", "provided", methodNorm, pathKey]),
    type: "API",
    name,
    method: methodNorm,
    path,
    direction: "provided",
    repoRoot,
    file: relPath,
    isCorrectlyClassified: false, // Added flag for classification correction
  };
}

function makeAPIEntityConsumed(
  repoRoot: string,
  relPath: string,
  url: string,
  method?: string
): APIEntity {
  const methodNorm = (method || "GET").toUpperCase();
  const urlKey = normalizeUrlForId(url);
  const name = `${methodNorm} ${url}`;
  return {
    id: stableId([repoRoot, "API", "consumed", methodNorm, urlKey]),
    type: "API",
    name,
    url,
    method: methodNorm,
    direction: "consumed",
    repoRoot,
    file: relPath,
  };
}

function makeTable(
  repoRoot: string,
  relPath: string,
  table: string
): DatabaseTableEntity {
  return {
    id: stableId([repoRoot, "DatabaseTable", table]),
    type: "DatabaseTable",
    name: table,
    repoRoot,
    file: relPath,
  };
}

function makeColumn(
  repoRoot: string,
  relPath: string,
  table: string,
  column: string
): DatabaseColumnEntity {
  return {
    id: stableId([repoRoot, "DatabaseColumn", table, column]),
    type: "DatabaseColumn",
    name: column,
    table,
    repoRoot,
    file: relPath,
  };
}

function makeConfig(
  repoRoot: string,
  relPath: string,
  key: string,
  valueSample?: string
): ConfigEntity {
  return {
    id: stableId([repoRoot, "Config", key]),
    type: "Config",
    name: key,
    valueSample,
    repoRoot,
    file: relPath,
  };
}

function makeTest(
  repoRoot: string,
  relPath: string,
  framework: string
): TestEntity {
  return {
    id: stableId([repoRoot, "Test", relPath, framework]),
    type: "Test",
    name: relPath,
    file: relPath,
    framework,
    repoRoot,
  };
}

function makeRepositoryEntity(repoRoot: string): RepositoryEntity {
  const name = repoRoot.split(/[\\/]/).pop() || repoRoot;
  return {
    id: stableId([repoRoot, "Repository"]),
    type: "Repository",
    name,
    repoRoot,
  };
}

function makeError(
  repoRoot: string,
  relPath: string,
  message: string,
  startLine: number
): ErrorMessageEntity {
  return {
    id: stableId([
      repoRoot,
      "ErrorMessage",
      relPath,
      message,
      String(startLine),
    ]),
    type: "ErrorMessage",
    message,
    repoRoot,
    file: relPath,
    span: { startLine, endLine: startLine },
  };
}

// Helper functions for API classification
function isFullURL(urlOrPath: string): boolean {
  // Check if it's a full URL with protocol
  return /^https?:\/\//.test(urlOrPath) || /^\/\//.test(urlOrPath);
}

function isServerFrameworkObject(objText: string): boolean {
  // Server-side framework patterns that provide APIs
  const serverPatterns = [
    "app", // Express: app.get(), app.post()
    "router", // Express Router: router.get()
    "server", // Generic server: server.get()
    "fastify", // Fastify: fastify.get()
    "koa", // Koa: koa.get() (though Koa uses different patterns)
    "hapi", // Hapi: hapi.get()
    "restify", // Restify: restify.get()
  ];

  return serverPatterns.some(
    (pattern) =>
      objText === pattern ||
      objText.endsWith(`.${pattern}`) ||
      objText.startsWith(`${pattern}.`)
  );
}

function isClientHTTPCall(objText: string, method: string): boolean {
  // Enhanced client-side HTTP library patterns that consume APIs
  const clientPatterns = [
    "axios", // axios.get(), axios.post()
    "axiosInstance", // custom axios instances
    "client", // client.get(), client.post() - generic HTTP client
    "http", // http.get(), http.post() - Node.js http module or similar
    "https", // https.get(), https.post() - Node.js https module
    "fetch", // fetch.get() - though fetch is usually a function call
    "request", // request.get(), request.post() - request library
    "superagent", // superagent.get(), superagent.post()
    "got", // got.get(), got.post()
    "needle", // needle.get(), needle.post()
    "node-fetch", // node-fetch library patterns
  ];

  // Frontend and React-specific patterns
  const frontendPatterns = [
    "this.http", // Angular HttpClient: this.http.get()
    "this.$http", // Vue.js axios: this.$http.get()
    "this.api", // Generic component API calls: this.api.get()
    "service", // API service objects: service.get()
    "httpClient", // Generic HTTP client: httpClient.get()
    "apiClient", // Generic API client: apiClient.get()
  ];

  const allPatterns = [...clientPatterns, ...frontendPatterns];

  // Check for exact matches and common variations
  const isDirectClient = allPatterns.some((pattern) => objText === pattern);

  // Check for object property access patterns (e.g., "imported.axios")
  const hasClientInName = allPatterns.some(
    (pattern) =>
      objText.endsWith(`.${pattern}`) ||
      objText.startsWith(`${pattern}.`) ||
      objText.includes(pattern)
  );

  // Special case for axios - very strong indicator of consumed API
  const isAxios = objText === "axios" || objText.includes("axios");

  const isHTTPMethod = ["get", "post", "put", "delete", "patch"].includes(
    method.toLowerCase()
  );

  // Debug logging for axios detection
  if (isAxios && isHTTPMethod) {
    logger.debug(
      `🔍 AXIOS DETECTED: objText="${objText}", method="${method}" -> CONSUMED API`
    );
  }

  return (isDirectClient || hasClientInName || isAxios) && isHTTPMethod;
}

function isHTTPClientCall(fnText: string): boolean {
  // Enhanced detection for HTTP client function calls
  // Guard: avoid matching server framework route registrations like app.get('/'), router.post('/'), fastify.get(...)
  const serverRoutePattern =
    /^(app|router|server|fastify|koa|hapi|restify)\.(get|post|put|delete|patch)$/i;
  if (serverRoutePattern.test(fnText)) {
    return false;
  }

  const httpClientPatterns = [
    /^(fetch|axios|request)$/i, // Direct function calls: fetch(), axios(), request()
    /^(axios|axiosInstance)\.(get|post|put|delete|patch)$/i, // Axios method calls: axios.get(), axiosInstance.get()
    /^(api|client|http|https)\.(get|post|put|delete|patch)$/i, // Generic client calls
    /\.(get|post|put|delete|patch)$/i, // Any object method call ending with HTTP verbs
    /^(superagent|got|needle)\./i, // HTTP libraries
    /^(this\.)?(http|api|client)\.(get|post|put|delete|patch)$/i, // Component methods
    /axios/i, // Any function text containing "axios" should be treated as client
  ];

  const isAxiosCall = fnText.toLowerCase().includes("axios");
  const isHTTPVerb = /\.(get|post|put|delete|patch)$/i.test(fnText);

  // Debug logging for axios detection
  if (isAxiosCall) {
    logger.debug(
      `🔍 HTTP CLIENT CALL DETECTED: "${fnText}" -> isAxios: ${isAxiosCall}, hasHTTPVerb: ${isHTTPVerb}`
    );
  }

  return (
    httpClientPatterns.some((pattern) => pattern.test(fnText)) ||
    (isAxiosCall && isHTTPVerb)
  );
}

function extractMethodFromFunctionName(fnText: string): string | undefined {
  // Extract HTTP method from function name patterns
  const methodMatch = fnText.match(/\.(get|post|put|delete|patch)$/i);
  if (methodMatch) {
    return methodMatch[1].toUpperCase();
  }

  // Handle direct function names like 'get', 'post', etc.
  const directMatch = fnText.match(/^(get|post|put|delete|patch)$/i);
  if (directMatch) {
    return directMatch[1].toUpperCase();
  }

  // Default to GET if no method is found
  return undefined;
}

// Basic AST traversal helper
function walk(node: any, cb: (n: any) => void) {
  cb(node);
  const count = node.namedChildCount ?? 0;
  for (let i = 0; i < count; i++) {
    const child = node.namedChild(i);
    if (child) walk(child, cb);
  }
}

// JS/TS heuristics for APIs, configs, errors, tests
function analyzeJsTs(root: any, code: string) {
  const findings: {
    provided: { method: string; path: string }[];
    consumed: { method?: string; url: string }[];
    configs: string[];
    errors: { message: string; line: number }[];
    tables: { name: string }[];
    testFramework?: string;
    calls: string[];
    functions: { name: string; start: number; end: number }[];
    classes: { name: string; start: number; end: number }[];
    variables: { name: string; start: number; end: number }[];
  } = {
    provided: [],
    consumed: [],
    configs: [],
    errors: [],
    tables: [],
    calls: [],
    functions: [],
    classes: [],
    variables: [],
  };

  // Heuristics to determine likely runtime context
  const codeLower = code.toLowerCase();
  const serverImportsRegex =
    /\b(from\s+['"](express|fastify|koa|hapi|restify)['"]|require\(['"](express|fastify|koa|hapi|restify)['"]\))/i;
  const nodeServerRegex =
    /\b(createServer\s*\(|express\s*\(|fastify\s*\(|new\s+Koa\s*\(|restify\.)/i;
  const frontendLibRegex =
    /\bfrom\s+['"](react|react-dom|next|vite|vue|@angular\/core)['"]/i;

  const likelyServerContext =
    serverImportsRegex.test(codeLower) || nodeServerRegex.test(codeLower);
  const likelyFrontendContext = frontendLibRegex.test(codeLower);

  walk(root, (n) => {
    const type = n.type as string;

    // DEBUG: Log all member_expression and call_expression nodes
    if (type === "member_expression" || type === "call_expression") {
      logger.debug(`\n=== AST Node Debug ===`);
      logger.debug(`Type: ${type}, Text: "${n.text}"`);
      if (type === "member_expression") {
        const obj = n.childForFieldName?.("object") || n.child(0);
        const prop = n.childForFieldName?.("property") || n.child(2);
        logger.debug(`Object: "${obj?.text}", Property: "${prop?.text}"`);
        logger.debug(`Parent type: ${n.parent?.type}`);
      }
      if (type === "call_expression") {
        const fnNode = n.childForFieldName?.("function") || n.child(0);
        logger.debug(`Function: "${fnNode?.text}"`);
      }
    }

    // Function declarations
    if (type === "function_declaration" || type === "method_definition") {
      const nameNode = n.childForFieldName?.("name") || n.child(1);
      const name = nameNode?.text ?? "anonymous";
      findings.functions.push({
        name,
        start: n.startPosition.row + 1,
        end: n.endPosition.row + 1,
      });
    }

    // Class
    if (type === "class_declaration") {
      const nameNode = n.childForFieldName?.("name") || n.child(1);
      const name = nameNode?.text ?? "AnonymousClass";
      findings.classes.push({
        name,
        start: n.startPosition.row + 1,
        end: n.endPosition.row + 1,
      });
    }

    // Variable declarator
    if (type === "variable_declarator") {
      const nameNode = n.childForFieldName?.("name") || n.child(0);
      const name = nameNode?.text ?? "var";
      findings.variables.push({
        name,
        start: n.startPosition.row + 1,
        end: n.endPosition.row + 1,
      });
    }

    // Calls (very rough: identifier followed by call)
    if (type === "call_expression") {
      const fnNode = n.childForFieldName?.("function") || n.child(0);
      const fnText = fnNode?.text ?? "";
      if (fnText) findings.calls.push(fnText);

      // Enhanced HTTP client detection (consumed API)
      if (isHTTPClientCall(fnText)) {
        const argNode =
          n.namedChildren?.find((c: any) => c.type === "arguments") ||
          n.child(1);
        const urlArg = argNode?.namedChildren?.[0] || argNode?.child?.(1);
        const urlText = urlArg?.text ?? "";
        if (urlText) {
          let cleaned = urlText.replace(/^['"`]/, "").replace(/['"`]$/, "");
          cleaned = stripTemplatePlaceholders(cleaned);
          // Extract method from function name if not already detected
          const method = extractMethodFromFunctionName(fnText);
          findings.consumed.push({ url: cleaned, method });
        }
      }
    }

    // Simplified API detection with explicit axios handling
    if (type === "member_expression") {
      const obj = n.childForFieldName?.("object") || n.child(0);
      const prop = n.childForFieldName?.("property") || n.child(2);
      const method = prop?.text?.toLowerCase();
      const objText = obj?.text ?? "";

      if (
        obj &&
        prop &&
        ["get", "post", "put", "delete", "patch"].includes(method)
      ) {
        const parent = n.parent;
        if (parent?.type === "call_expression") {
          const args =
            parent.childForFieldName?.("arguments") || parent.child(1);
          const firstArg = args?.namedChildren?.[0];
          const pathText = firstArg?.text ?? "";
          let urlOrPath = pathText.replace(/^['"`]/, "").replace(/['"`]$/, "");
          urlOrPath = stripTemplatePlaceholders(urlOrPath);

          if (urlOrPath) {
            logger.debug(`\n=== API Classification ===`);
            logger.debug(
              `Object: "${objText}", Method: "${method}", URL/Path: "${urlOrPath}"`
            );

            // PRIORITY 1: Explicit axios detection (highest priority)
            if (objText === "axios") {
              logger.debug(`-> CONSUMED (axios detected)`);
              findings.consumed.push({ url: urlOrPath, method });
            }
            // PRIORITY 2: Other HTTP client libraries
            else if (
              ["client", "http", "https", "request", "fetch"].includes(
                objText
              ) ||
              objText.includes("axios") ||
              objText.includes("client") ||
              objText.includes("http")
            ) {
              logger.debug(`-> CONSUMED (HTTP client library: ${objText})`);
              findings.consumed.push({ url: urlOrPath, method });
            }
            // PRIORITY 3: Server frameworks providing APIs
            else if (
              ["app", "router", "server", "fastify"].includes(objText) &&
              likelyServerContext &&
              !isFullURL(urlOrPath)
            ) {
              logger.debug(
                `-> PROVIDED (server framework: ${objText}, server context detected)`
              );
              findings.provided.push({ method, path: urlOrPath });
            } else if (isFullURL(urlOrPath)) {
              logger.debug(`-> CONSUMED (full URL detected)`);
              findings.consumed.push({ url: urlOrPath, method });
            }
            // PRIORITY 4: Full URLs are typically consumed
            else if (
              urlOrPath.startsWith("http") ||
              urlOrPath.startsWith("//")
            ) {
              logger.debug(`-> CONSUMED (full URL detected)`);
              findings.consumed.push({ url: urlOrPath, method });
            }
            // DEFAULT: If we can't classify, skip (don't assume)
            else {
              logger.debug(
                `-> SKIPPED (unclear classification for: ${objText})`
              );
            }
          }
        }
      }
    }

    // process.env.XYZ config usage
    if (type === "member_expression") {
      const text = n.text ?? "";
      const m = text.match(/process\.env\.([A-Za-z0-9_]+)/);
      if (m) {
        findings.configs.push(m[1]);
      }
    }

    // Throw new Error("message")
    if (type === "throw_statement") {
      const msgNode = n.descendantsOfType?.(["string"])?.[0];
      const raw = msgNode?.text ?? "";
      const message = raw.replace(/^['"`]/, "").replace(/['"`]$/, "");
      if (message) {
        findings.errors.push({ message, line: n.startPosition.row + 1 });
      }
    }
  });

  // Heuristic test framework detection by source text
  const srcLower = code.toLowerCase();
  if (srcLower.includes("jest.") || srcLower.includes("describe(")) {
    findings.testFramework = "jest";
  } else if (srcLower.includes("mocha") || srcLower.includes("chai")) {
    findings.testFramework = "mocha";
  }

  return findings;
}

function analyzePython(root: any, code: string) {
  const findings = {
    functions: [] as { name: string; start: number; end: number }[],
    classes: [] as { name: string; start: number; end: number }[],
    variables: [] as { name: string; start: number; end: number }[],
    consumed: [] as { method?: string; url: string }[],
    provided: [] as { method: string; path: string }[],
    configs: [] as string[],
    tables: [] as { name: string }[],
    errors: [] as { message: string; line: number }[],
    calls: [] as string[],
    testFramework: undefined as string | undefined,
  };

  walk(root, (n) => {
    const type = n.type as string;

    if (type === "function_definition") {
      const nameNode = n.childForFieldName?.("name");
      const name = nameNode?.text ?? "function";
      findings.functions.push({
        name,
        start: n.startPosition.row + 1,
        end: n.endPosition.row + 1,
      });
    }
    if (type === "class_definition") {
      const nameNode = n.childForFieldName?.("name");
      const name = nameNode?.text ?? "Class";
      findings.classes.push({
        name,
        start: n.startPosition.row + 1,
        end: n.endPosition.row + 1,
      });
    }
    if (type === "assignment") {
      const nameNode = n.child(0);
      const name = nameNode?.text ?? "var";
      findings.variables.push({
        name,
        start: n.startPosition.row + 1,
        end: n.endPosition.row + 1,
      });
    }

    if (type === "call") {
      const fnNode = n.child(0);
      const fnText = fnNode?.text ?? "";
      if (fnText) findings.calls.push(fnText);

      // requests.get("https://..."), requests.post(...)
      if (/^(requests\.(get|post|put|delete|patch))$/i.test(fnText)) {
        const argNode = n.child(1);
        const urlArg = argNode?.namedChildren?.[0];
        const urlText = urlArg?.text ?? "";
        if (urlText) {
          const cleaned = urlText.replace(/^['"`]/, "").replace(/['"`]$/, "");
          findings.consumed.push({ url: cleaned });
        }
      }
    }

    // os.getenv("KEY")
    if (type === "call") {
      const fnNode = n.child(0);
      if (fnNode?.text === "os.getenv") {
        const args = n.child(1);
        const keyNode = args?.namedChildren?.[0];
        const key = keyNode?.text?.replace(/^['"`]/, "").replace(/['"`]$/, "");
        if (key) findings.configs.push(key);
      }
    }

    // raise Exception("msg")
    if (type === "raise_statement") {
      const strNode = n.descendantsOfType?.(["string"])?.[0];
      const raw = strNode?.text ?? "";
      const message = raw.replace(/^['"`]/, "").replace(/['"`]$/, "");
      if (message) {
        findings.errors.push({ message, line: n.startPosition.row + 1 });
      }
    }
  });

  const lower = code.toLowerCase();
  if (lower.includes("pytest") || lower.includes("unittest")) {
    findings.testFramework = lower.includes("pytest") ? "pytest" : "unittest";
  }

  return findings;
}

function analyzeJavaLike(root: any, code: string) {
  const findings = {
    functions: [] as { name: string; start: number; end: number }[],
    classes: [] as { name: string; start: number; end: number }[],
    variables: [] as { name: string; start: number; end: number }[],
    consumed: [] as { method?: string; url: string }[],
    provided: [] as { method: string; path: string }[],
    configs: [] as string[],
    tables: [] as { name: string }[],
    errors: [] as { message: string; line: number }[],
    calls: [] as string[],
    testFramework: undefined as string | undefined,
  };

  // Helpers
  function getModifiers(node: any): any | null {
    if (!node || !node.namedChildren) return null;
    const mods = node.namedChildren.find((c: any) => c.type === "modifiers");
    return mods || null;
  }
  function annotationName(anno: any): string {
    // Works for both 'annotation' and 'marker_annotation'
    const raw = anno?.text ?? "";
    const m = raw.match(/^@([A-Za-z0-9_.$]+)/);
    if (m && m[1]) {
      const parts = m[1].split(".");
      return parts[parts.length - 1] || "";
    }
    // Fallback to previous heuristic
    return anno?.child(1)?.text ?? "";
  }
  function annotationArgs(anno: any): any {
    // For 'annotation' nodes try to find the argument list child,
    // for 'marker_annotation' there are no args.
    if (!anno) return null;
    if (anno.type === "marker_annotation") return null;
    // Try common child positions/types
    const named = anno.namedChildren || [];
    const argLike = named.find(
      (c: any) =>
        c.type.includes("argument") ||
        c.type === "element_value" ||
        c.type === "element_value_pair" ||
        c.type === "element_value_array_initializer"
    );
    return argLike ?? anno.child?.(2) ?? null;
  }
  function parseAnnotation(anno: any): {
    name: string;
    path: string | null;
    method: string | null;
  } {
    const t = anno?.text ?? "";
    const nameMatch = t.match(/^@([A-Za-z0-9_.$]+)/);
    const fullName = nameMatch ? nameMatch[1] : "";
    const name = fullName.split(".").pop() || "";

    // Extract inner content between parentheses if present
    let inner: string | null = null;
    const parenMatch = t.match(/\(([\s\S]*)\)/);
    if (parenMatch) inner = parenMatch[1];

    // Extract path: first quoted string OR value="..." OR path="..."
    let path: string | null = null;
    if (inner) {
      const strMatch = inner.match(/"([^"]*)"/);
      if (strMatch) {
        path = strMatch[1];
      } else {
        const kvMatch = inner.match(/\b(?:value|path)\s*=\s*"([^"]*)"/);
        if (kvMatch) path = kvMatch[1];
      }
    }

    // Extract method for @RequestMapping
    let method: string | null = null;
    if (inner) {
      const m = inner.match(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/i);
      if (m) {
        method = m[1].toUpperCase();
      } else {
        const m2 = inner.match(
          /\bmethod\s*=\s*RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/i
        );
        if (m2) method = m2[1].toUpperCase();
      }
    }

    return { name, path, method };
  }

  function extractPathFromAnnotationArgs(argsNode: any): string | null {
    if (!argsNode) return null;
    const strNode =
      argsNode.descendantsOfType?.(["string"])?.[0] ||
      argsNode.namedChildren?.find((c: any) => c.type === "string");
    if (strNode) {
      return strNode.text.replace(/^['"`]/, "").replace(/['"`]$/, "");
    }
    const valueAssign = argsNode.namedChildren?.find(
      (c: any) =>
        c.type === "element_value_pair" &&
        c.text.startsWith("value") &&
        c.text.includes("=")
    );
    if (valueAssign) {
      const eqIdx = valueAssign.text.indexOf("=");
      if (eqIdx !== -1) {
        return valueAssign.text
          .slice(eqIdx + 1)
          .trim()
          .replace(/^['"`]/, "")
          .replace(/['"`]$/, "");
      }
    }
    // also support path="..."
    const pathAssign = argsNode.namedChildren?.find(
      (c: any) =>
        c.type === "element_value_pair" &&
        c.text.startsWith("path") &&
        c.text.includes("=")
    );
    if (pathAssign) {
      const eqIdx = pathAssign.text.indexOf("=");
      if (eqIdx !== -1) {
        return pathAssign.text
          .slice(eqIdx + 1)
          .trim()
          .replace(/^['"`]/, "")
          .replace(/['"`]$/, "");
      }
    }
    return null;
  }
  function extractMethodFromAnnotationArgs(argsNode: any): string | null {
    if (!argsNode) return null;
    const methodAssign = argsNode.namedChildren?.find(
      (c: any) =>
        c.type === "element_value_pair" &&
        c.text.startsWith("method") &&
        c.text.includes("=")
    );
    if (methodAssign) {
      const match = methodAssign.text.match(
        /RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/i
      );
      if (match) return match[1].toUpperCase();
    }
    return null;
  }
  function findEnclosingClass(node: any): any | null {
    let p = node?.parent;
    while (p) {
      if (p.type === "class_declaration") return p;
      p = p.parent;
    }
    return null;
  }
  function isControllerClass(classNode: any): boolean {
    const mods = getModifiers(classNode);
    if (!mods || !mods.namedChildren) return false;
    for (const mod of mods.namedChildren) {
      if (mod.type === "annotation" || mod.type === "marker_annotation") {
        const name = annotationName(mod);
        if (name === "RestController" || name === "Controller") return true;
      }
    }
    return false;
  }
  function getClassBasePath(classNode: any): string | null {
    const mods = getModifiers(classNode);
    if (!mods || !mods.namedChildren) return null;
    for (const mod of mods.namedChildren) {
      if (mod.type === "annotation" || mod.type === "marker_annotation") {
        const info = parseAnnotation(mod);
        if (info.name === "RequestMapping" && info.path != null) {
          return info.path;
        }
      }
    }
    return null;
  }

  // Consumed API detection (RestTemplate, WebClient)
  walk(root, (n) => {
    if (n.type === "method_invocation") {
      const methodName = n.child(2)?.text ?? "";
      const targetObj = n.child(0)?.text ?? "";

      // RestTemplate calls
      if (
        /^(exchange|getForObject|getForEntity|postForObject|postForEntity|put|delete)$/i.test(
          methodName
        )
      ) {
        const argsNode = n.child(3);
        if (argsNode?.namedChildren?.length) {
          const urlNode = argsNode.namedChildren.find(
            (c: any) => c.type === "string"
          );
          if (urlNode) {
            const url = urlNode.text
              .replace(/^['"`]/, "")
              .replace(/['"`]$/, "");
            let httpMethod: string | undefined = undefined;
            if (/^get/i.test(methodName)) httpMethod = "GET";
            else if (/^post/i.test(methodName)) httpMethod = "POST";
            else if (/^put/i.test(methodName)) httpMethod = "PUT";
            else if (/^delete/i.test(methodName)) httpMethod = "DELETE";
            else if (/^exchange/i.test(methodName)) {
              const methodArg = argsNode.namedChildren.find((c: any) =>
                c.text?.includes("HttpMethod.")
              );
              if (methodArg) {
                const m = methodArg.text.match(
                  /HttpMethod\.(GET|POST|PUT|DELETE|PATCH)/i
                );
                if (m) httpMethod = m[1].toUpperCase();
              }
            }
            findings.consumed.push({ method: httpMethod, url });
          }
        }
      }

      // WebClient chaining (webClient.get().uri("..."))
      if (
        /^(get|post|put|delete|patch)$/i.test(methodName) &&
        /webClient/i.test(targetObj)
      ) {
        let parent = n.parent;
        while (parent) {
          if (parent.type === "method_invocation") {
            const uriCall = parent.namedChildren?.find(
              (c: any) =>
                c.type === "method_invocation" && c.child(2)?.text === "uri"
            );
            if (uriCall) {
              const argsNode = uriCall.child(3);
              if (argsNode?.namedChildren?.length) {
                const urlNode = argsNode.namedChildren.find(
                  (c: any) => c.type === "string"
                );
                if (urlNode) {
                  const url = urlNode.text
                    .replace(/^['"`]/, "")
                    .replace(/['"`]$/, "");
                  findings.consumed.push({
                    method: methodName.toUpperCase(),
                    url,
                  });
                }
              }
              break;
            }
          }
          parent = parent.parent;
        }
      }

      // Logger errors
      const txt = n.text ?? "";
      const errMatch = txt.match(/\.error\(\s*["'`](.*?)["'`]/);
      if (errMatch) {
        findings.errors.push({
          message: errMatch[1],
          line: n.startPosition.row + 1,
        });
      }
    }
  });

  // Classes, functions, and provided APIs (Spring MVC annotations)
  walk(root, (n) => {
    const type = n.type as string;

    if (type === "class_declaration") {
      const nameNode = n.childForFieldName?.("name") || n.child(1);
      const name = nameNode?.text ?? "Class";
      findings.classes.push({
        name,
        start: n.startPosition.row + 1,
        end: n.endPosition.row + 1,
      });
    }

    if (type === "method_declaration") {
      const nameNode = n.childForFieldName?.("name") || n.child(1);
      const name = nameNode?.text ?? "method";
      findings.functions.push({
        name,
        start: n.startPosition.row + 1,
        end: n.endPosition.row + 1,
      });

      // Inspect annotations on this method (modifiers is a CHILD of method_declaration)
      const mods = getModifiers(n);
      let methodPath: string | null = null;
      let httpMethod: string | null = null;

      if (mods?.namedChildren?.length) {
        for (const mod of mods.namedChildren) {
          if (mod.type !== "annotation" && mod.type !== "marker_annotation")
            continue;

          const info = parseAnnotation(mod);
          const anno = info.name;

          if (
            /^(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)$/.test(
              anno
            )
          ) {
            httpMethod = anno.replace("Mapping", "").toUpperCase();
            methodPath = info.path ?? "";
          } else if (anno === "RequestMapping") {
            httpMethod = (info.method ?? "GET").toUpperCase();
            methodPath = info.path ?? "";
          }
        }
      }

      // Attach only if enclosing class is a controller
      if (httpMethod) {
        const cls = findEnclosingClass(n);
        if (cls && isControllerClass(cls)) {
          const base = getClassBasePath(cls);
          let fullPath = "";
          if (base) fullPath += base.endsWith("/") ? base.slice(0, -1) : base;
          if (methodPath) {
            if (!methodPath.startsWith("/") && methodPath.length > 0)
              fullPath += "/";
            fullPath += methodPath;
          }
          if (!fullPath) fullPath = "/";
          if (!fullPath.startsWith("/")) fullPath = "/" + fullPath;
          findings.provided.push({ method: httpMethod, path: fullPath });
        }
      }
    }
  });

  const lower = code.toLowerCase();
  if (lower.includes("junit") || lower.includes("@test")) {
    findings.testFramework = "junit";
  } else if (lower.includes("xunit")) {
    findings.testFramework = "xunit";
  } else if (lower.includes("nunit")) {
    findings.testFramework = "nunit";
  }

  return findings;
}

export async function extractEntities(
  repos: RepoFiles[]
): Promise<AnyEntity[]> {
  const parser = new (Parser as any)();
  const entities: AnyEntity[] = [];

  for (const repo of repos) {
    // Create a Repository entity for each repository
    entities.push(makeRepositoryEntity(repo.repoRoot));

    for (const f of repo.files) {
      try {
        // Always create a File entity
        entities.push(makeFileEntity(repo.repoRoot, f.relPath));

        const langMod =
          f.language !== "unknown"
            ? langModuleFor(f.language as LanguageId)
            : null;
        if (!langMod) {
          continue; // unsupported
        }

        parser.setLanguage(langMod);
        const tree = parser.parse(f.content);
        const root = tree.rootNode;

        // Language specific analysis
        let res:
          | ReturnType<typeof analyzeJsTs>
          | ReturnType<typeof analyzePython>
          | ReturnType<typeof analyzeJavaLike>;

        if (f.language === "javascript" || f.language === "typescript") {
          res = analyzeJsTs(root, f.content);
        } else if (f.language === "python") {
          res = analyzePython(root, f.content);
        } else {
          // java / csharp - treat similarly
          res = analyzeJavaLike(root, f.content);
        }

        // Emit classes
        for (const c of (res as any).classes) {
          entities.push(
            makeClassEntity(
              repo.repoRoot,
              f.relPath,
              f.language,
              c.name,
              c.start,
              c.end
            )
          );
        }

        // Emit functions
        const fileFuncNames: string[] = [];
        for (const fn of (res as any).functions) {
          const func = makeFunctionEntity(
            repo.repoRoot,
            f.relPath,
            f.language,
            fn.name,
            fn.start,
            fn.end
          );
          // attach heuristic relationships on function meta for later relationship building
          (func as FunctionEntity).calls = (res as any).calls ?? [];
          (func as FunctionEntity).apisProvided = (res as any).provided ?? [];
          (func as FunctionEntity).apisUsed = (res as any).consumed ?? [];
          (func as FunctionEntity).tablesQueried =
            (res as any).tables?.map((t: any) => t.name) ?? [];
          (func as FunctionEntity).configsUsed = (res as any).configs ?? [];

          entities.push(func);
          fileFuncNames.push(fn.name);
        }

        // Variables
        for (const v of (res as any).variables) {
          entities.push(
            makeVariableEntity(
              repo.repoRoot,
              f.relPath,
              f.language,
              v.name,
              v.start,
              v.end
            )
          );
        }

        // Debug what's in the findings
        if (f.relPath.includes("HomeService")) {
          logger.debug(`\n=== HomeService Findings ===`);
          logger.debug(
            `Provided APIs: ${JSON.stringify((res as any).provided)}`
          );
          logger.debug(
            `Consumed APIs: ${JSON.stringify((res as any).consumed)}`
          );
        }

        // Enhanced API classification correction
        const providedAPIs = (res as any).provided ?? [];
        const consumedAPIs = (res as any).consumed ?? [];
        const hasAxios = f.content.includes("axios");

        logger.debug(`\n=== Processing File: ${f.relPath} ===`);
        logger.debug(`Has axios: ${hasAxios}`);
        logger.debug(`Provided APIs found: ${providedAPIs.length}`);
        logger.debug(`Consumed APIs found: ${consumedAPIs.length}`);

        // Correct classification for provided APIs
        for (const p of providedAPIs) {
          if (isFullURL(p.path)) {
            logger.debug(
              `🔧 Correcting PROVIDED -> CONSUMED: ${JSON.stringify(p)}`
            );
            entities.push(
              makeAPIEntityConsumed(repo.repoRoot, f.relPath, p.path, p.method)
            );
          } else {
            entities.push(
              makeAPIEntityProvided(repo.repoRoot, f.relPath, p.method, p.path)
            );
          }
        }

        // Create CONSUMED APIs
        for (const c of consumedAPIs) {
          entities.push(
            makeAPIEntityConsumed(repo.repoRoot, f.relPath, c.url, c.method)
          );
        }

        // Configs
        for (const k of (res as any).configs ?? []) {
          entities.push(makeConfig(repo.repoRoot, f.relPath, k));
        }

        // Errors
        for (const e of (res as any).errors ?? []) {
          entities.push(makeError(repo.repoRoot, f.relPath, e.message, e.line));
        }

        // Tests
        const isTestFile =
          /(\.test\.|\.spec\.)/.test(f.relPath.toLowerCase()) ||
          (res as any).testFramework;
        if (isTestFile) {
          entities.push(
            makeTest(
              repo.repoRoot,
              f.relPath,
              (res as any).testFramework || "unknown"
            )
          );
        }

        // Tables/Columns - too language-specific; placeholder for future SQL extraction
        // Here we emit only tables if any were heuristically found (none by default).
        for (const t of (res as any).tables ?? []) {
          entities.push(makeTable(repo.repoRoot, f.relPath, t.name));
        }
      } catch (e) {
        logger.warn(`AST extraction failed for ${f.relPath}`, {
          error: (e as Error)?.message,
        });
      }
    }
  }

  logger.info(`AST extraction produced ${entities.length} entities`);
  return entities;
}
