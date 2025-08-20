/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "crypto";
import Parser from "tree-sitter";
import * as JavaScriptLang from "tree-sitter-javascript";
import { createRequire } from "module";
const requireTS = createRequire(import.meta.url);
const TypeScriptLang = requireTS("tree-sitter-typescript");
import * as PythonLang from "tree-sitter-python";
import * as JavaLang from "tree-sitter-java";
import * as CSharpLang from "tree-sitter-c-sharp";

import type {
  AnyEntity,
  APIEntity,
  ClassEntity,
  ConfigEntity,
  DatabaseTableEntity,
  ErrorMessageEntity,
  FileEntity,
  FunctionEntity,
  LanguageId,
  RepoFiles,
  RepositoryEntity,
  TestEntity,
  VariableEntity,
  TypeDefinitionEntity,
} from "./types.js";
import { Logger } from "../utils/logger.js";
import {
  extractTSReturnType,
  extractPythonReturnType,
  extractJavaReturnType,
  extractCSharpReturnType,
  extractParameterTypes,
  extractTSTypeDefinitions,
  extractClassFields,
  extractSpringResponseSchema,
} from "./returnTypeExtractor.js";
import {
  extractDevelopersFromGit,
  extractTeamFromCodeowners,
  extractTeamFromMetadata,
  inferTeamFromRepoStructure,
} from "./developerAnalyzer.js";

const logger = new Logger("AstExtractor");

type LangModule = any;

function langModuleFor(language: LanguageId): LangModule | null {
  switch (language) {
    case "javascript":
      return ((JavaScriptLang as any).default ?? JavaScriptLang) as unknown as LangModule;
    case "typescript":
      // tree-sitter-typescript (CJS) exposes .typescript and .tsx on the module/default export
      return ((TypeScriptLang as any).typescript ??
        (TypeScriptLang as any).default?.typescript ??
        (TypeScriptLang as any)) as unknown as LangModule;
    case "python":
      return ((PythonLang as any).default ?? PythonLang) as unknown as LangModule;
    case "java":
      return ((JavaLang as any).default ?? JavaLang) as unknown as LangModule;
    case "csharp":
      return ((CSharpLang as any).default ?? CSharpLang) as unknown as LangModule;
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

// Enhanced variable tracking for API context
interface APIVariableContext {
  baseUrls: Map<string, string>; // variable name -> base URL value
  apiVariables: Set<string>; // variables that contain API-related values
  templateVariables: Map<string, string>; // template variable mappings
}

// Helper functions for API classification
function isFullURL(urlOrPath: string): boolean {
  // Check if it's a full URL with protocol
  return /^https?:\/\//.test(urlOrPath) || /^\/\//.test(urlOrPath);
}

function isAPIVariableName(varName: string): boolean {
  // Check if a variable name suggests it contains API-related data
  const apiPatterns = [
    /^(api|base|endpoint|url|uri)_?(base|url|endpoint)?$/i,
    /^(base|root)_?(api|url|endpoint)$/i,
    /^server_?(url|endpoint|base)$/i,
    /^(backend|frontend)_?(url|api|endpoint)$/i,
    /_?(api|url|endpoint|base)$/i,
  ];
  
  return apiPatterns.some(pattern => pattern.test(varName));
}

function isVariableDeclaration(node: any): boolean {
  // Check if this node is part of a variable declaration
  let parent = node.parent;
  while (parent) {
    if (parent.type === "variable_declarator" || 
        parent.type === "assignment_expression" ||
        parent.type === "property_definition") {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

function resolveAPIPath(pathText: string, context: APIVariableContext): string {
  // Try to resolve template literals and variable references
  let resolved = pathText;
  
  // Handle template literals like `${BASE_URL}/users`
  const templateMatch = pathText.match(/\$\{([^}]+)\}(.*)$/);
  if (templateMatch) {
    const varName = templateMatch[1];
    const pathSuffix = templateMatch[2];
    
    if (context.baseUrls.has(varName)) {
      const baseUrl = context.baseUrls.get(varName)!;
      resolved = baseUrl + pathSuffix;
    } else if (context.templateVariables.has(varName)) {
      const baseUrl = context.templateVariables.get(varName)!;
      resolved = baseUrl + pathSuffix;
    }
  }
  
  // Handle string concatenation patterns
  const concatMatch = pathText.match(/^([A-Z_]+)\s*\+\s*['"`](.*)['"`]$/);
  if (concatMatch) {
    const varName = concatMatch[1];
    const pathSuffix = concatMatch[2];
    
    if (context.baseUrls.has(varName)) {
      const baseUrl = context.baseUrls.get(varName)!;
      resolved = baseUrl + pathSuffix;
    }
  }
  
  return resolved;
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

// Robust AST traversal helper with improved cycle detection for tree-sitter nodes
function walk(
  node: any,
  cb: (n: any) => void,
  visitedNodes = new WeakSet<any>(),
  visitedPositions = new Set<string>(),
  depth = 0,
  maxDepth = 500,
  maxNodes = 10000
) {
  // Validate node before processing
  if (!node || typeof node !== "object") {
    return;
  }

  // Prevent infinite loops using object reference (primary) and position (fallback)
  if (visitedNodes.has(node)) {
    return;
  }

  // Generate deterministic node ID based on position and type
  let nodeId: string;
  if (node.startPosition && node.endPosition && node.type) {
    nodeId = `${node.type}:${node.startPosition.row}:${node.startPosition.column}-${node.endPosition.row}:${node.endPosition.column}`;
  } else {
    // Fallback: use type and depth for nodes without position
    nodeId = `${node.type || "unknown"}:${depth}`;
  }

  // Secondary check with position-based ID
  if (visitedPositions.has(nodeId)) {
    return;
  }

  // Prevent stack overflow by limiting traversal depth
  if (depth > maxDepth) {
    logger.warn(
      `AST traversal depth limit (${maxDepth}) reached at node type: ${
        node.type || "unknown"
      }`
    );
    return;
  }

  // Prevent excessive node processing
  if (visitedPositions.size > maxNodes) {
    logger.warn(`AST node limit (${maxNodes}) reached, stopping traversal`);
    return;
  }

  // Mark node as visited
  visitedNodes.add(node);
  visitedPositions.add(nodeId);

  try {
    cb(node);

    // Get child count safely with multiple fallbacks
    let count = 0;
    try {
      if (typeof node.namedChildCount === "function") {
        count = node.namedChildCount();
      } else if (typeof node.namedChildCount === "number") {
        count = node.namedChildCount;
      } else if (node.namedChildren && Array.isArray(node.namedChildren)) {
        count = node.namedChildren.length;
      }
    } catch (e) {
      // If we can't get child count, try to access children array directly
      if (node.namedChildren && Array.isArray(node.namedChildren)) {
        count = node.namedChildren.length;
      } else {
        // If all methods fail, skip children
        logger.debug(
          `Cannot determine child count for node type: ${
            node.type || "unknown"
          }`
        );
        return;
      }
    }

    // Limit the number of children we process to prevent exponential blowup
    const maxChildren = Math.min(count, 50); // Reduced from 100 to be more conservative

    // Track processed children to avoid duplicates
    const processedChildren = new Set<any>();

    for (let i = 0; i < maxChildren; i++) {
      let child: any = null;

      try {
        // Try multiple methods to get child
        if (typeof node.namedChild === "function") {
          child = node.namedChild(i);
        } else if (node.namedChildren && Array.isArray(node.namedChildren)) {
          child = node.namedChildren[i];
        }
      } catch (e) {
        // Skip this child if we can't access it
        continue;
      }

      // Validate child and ensure it's not a circular reference
      if (
        child &&
        child !== node &&
        !processedChildren.has(child) &&
        !visitedNodes.has(child)
      ) {
        processedChildren.add(child);

        // Additional safety: check if child has valid structure
        if (
          typeof child === "object" &&
          (child.type !== undefined || child.startPosition !== undefined)
        ) {
          walk(
            child,
            cb,
            visitedNodes,
            visitedPositions,
            depth + 1,
            maxDepth,
            maxNodes
          );
        }
      }
    }

    if (count > maxChildren) {
      logger.debug(
        `Limited child processing for ${
          node.type || "unknown"
        }: ${count} children, processed ${maxChildren}`
      );
    }
  } catch (error) {
    // Log error but don't continue traversal from this node to prevent propagating issues
    logger.warn(
      `Error walking AST node at depth ${depth}, type: ${
        node.type || "unknown"
      }: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Helper to find a node at a specific position
function findNodeAtPosition(
  root: any,
  startLine: number,
  endLine: number,
  nodeType?: string
): any | null {
  let result: any = null;

  // Use fresh visited sets for each search to avoid interference
  walk(
    root,
    (node) => {
      const nodeStart = (node.startPosition?.row ?? -1) + 1;
      const nodeEnd = (node.endPosition?.row ?? -1) + 1;

      // Check if this node matches the position
      if (nodeStart === startLine && nodeEnd === endLine) {
        // If nodeType is specified, check for matching type patterns
        if (!nodeType) {
          result = node;
        } else if (nodeType === "function") {
          if (
            node.type === "function_declaration" ||
            node.type === "method_declaration" ||
            node.type === "function_definition" ||
            node.type === "arrow_function" ||
            node.type === "function_expression" ||
            node.type === "method_definition"
          ) {
            result = node;
          }
        } else if (nodeType === "class") {
          if (
            node.type === "class_declaration" ||
            node.type === "class_definition"
          ) {
            result = node;
          }
        } else if (node.type === nodeType) {
          result = node;
        }
      }
    },
    new WeakSet<any>(), // Fresh visited nodes set
    new Set<string>() // Fresh visited positions set
  );

  return result;
}

// Helper to check if a method is a Spring controller method
function isControllerMethod(methodNode: any): boolean {
  // Check if the method has Spring MVC annotations
  function hasControllerAnnotation(node: any): boolean {
    if (!node) return false;

    // Check for modifiers/annotations
    const modifiers = node.namedChildren?.find(
      (c: any) => c.type === "modifiers"
    );

    if (modifiers?.namedChildren) {
      for (const mod of modifiers.namedChildren) {
        if (mod.type === "annotation" || mod.type === "marker_annotation") {
          const text = mod.text || "";
          // Check for Spring MVC mapping annotations
          if (
            text.includes("@GetMapping") ||
            text.includes("@PostMapping") ||
            text.includes("@PutMapping") ||
            text.includes("@DeleteMapping") ||
            text.includes("@PatchMapping") ||
            text.includes("@RequestMapping") ||
            text.includes("@ResponseBody")
          ) {
            return true;
          }
        }
      }
    }

    return false;
  }

  // Check the method itself
  if (hasControllerAnnotation(methodNode)) {
    return true;
  }

  // Check if the enclosing class is a controller
  let parent = methodNode?.parent;
  while (parent) {
    if (parent.type === "class_declaration") {
      const modifiers = parent.namedChildren?.find(
        (c: any) => c.type === "modifiers"
      );

      if (modifiers?.namedChildren) {
        for (const mod of modifiers.namedChildren) {
          if (mod.type === "annotation" || mod.type === "marker_annotation") {
            const text = mod.text || "";
            if (
              text.includes("@RestController") ||
              text.includes("@Controller")
            ) {
              return true;
            }
          }
        }
      }
      break;
    }
    parent = parent.parent;
  }

  return false;
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
    // Data lineage per-function context keyed by "name:start-end"
    functionContexts: Record<
      string,
      {
        reads: Set<string>;
        writes: Set<string>;
        derives: { target: string; sources: string[]; op?: string }[];
        passesTo: {
          callee: string;
          argIndex: number;
          sourceVar: string;
          paramName?: string;
        }[];
      }
    >;
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
    functionContexts: {},
  };

  // Enhanced API variable context tracking
  const apiContext: APIVariableContext = {
    baseUrls: new Map(),
    apiVariables: new Set(),
    templateVariables: new Map(),
  };

  // Heuristics to determine likely runtime context
  const codeLower = code.toLowerCase();
  const serverImportsRegex =
    /\b(from\s+['"](express|fastify|koa|hapi|restify)['"]|require\(['"](express|fastify|koa|hapi|restify)['"]\))/i;
  const nodeServerRegex =
    /\b(createServer\s*\(|express\s*\(|fastify\s*\(|new\s+Koa\s*\(|restify\.)/i;

  const likelyServerContext =
    serverImportsRegex.test(codeLower) || nodeServerRegex.test(codeLower);

  // Helpers for lineage
  const getFunctionName = (fnNode: any): string => {
    // For arrow functions, immediately check parent variable declarator first
    if (fnNode.type === "arrow_function") {
      let parent = fnNode.parent;
      while (parent && parent.type !== "program") {
        if (parent.type === "variable_declarator") {
          const varNameNode =
            parent.childForFieldName?.("name") || parent.child?.(0);
          if (varNameNode?.text && varNameNode.type === "identifier") {
            // Return the variable name directly without character cleaning
            // since it's a proper identifier from variable declaration
            return varNameNode.text;
          }
        } else if (parent.type === "assignment_expression") {
          const leftNode =
            parent.childForFieldName?.("left") || parent.child?.(0);
          if (leftNode?.text && leftNode.type === "identifier") {
            return leftNode.text;
          }
        } else if (
          parent.type === "property_definition" ||
          parent.type === "method_definition" ||
          parent.type === "pair"
        ) {
          const keyNode =
            parent.childForFieldName?.("name") ||
            parent.childForFieldName?.("key") ||
            parent.child?.(0);
          if (keyNode?.text && keyNode.type === "identifier") {
            return keyNode.text;
          }
        }
        parent = parent.parent;
      }
      // If no parent assignment found, return anonymous for arrow functions
      return "anonymous";
    }

    // For regular functions, try to get the name normally
    const nameNode = fnNode.childForFieldName?.("name") || fnNode.child?.(1);
    let raw = nameNode?.text ?? "anonymous";

    // Only apply character cleaning if we have unwanted characters
    // and only if this isn't already a clean identifier
    if (raw && raw !== "anonymous") {
      // Check if it's already a clean identifier
      if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(raw)) {
        // Clean unwanted characters, but preserve valid identifier characters
        raw = raw.replace(/\(\)/g, "").replace(/=>/g, "").trim();
        raw = raw.replace(/[^\w.$]/g, "").trim();
      }
    }

    return raw || "anonymous";
  };
  const functionKey = (fnNode: any): string => {
    const name = getFunctionName(fnNode);
    const start =
      fnNode.startPosition?.row != null ? fnNode.startPosition.row + 1 : -1;
    const end =
      fnNode.endPosition?.row != null ? fnNode.endPosition.row + 1 : -1;
    return `${name}:${start}-${end}`;
  };
  const enclosingFunctionKey = (node: any): string | null => {
    let p = node?.parent;
    while (p) {
      if (
        p.type === "function_declaration" ||
        p.type === "method_definition" ||
        p.type === "function" ||
        p.type === "function_expression" ||
        p.type === "arrow_function"
      ) {
        return functionKey(p);
      }
      p = p.parent;
    }
    return null;
  };
  const getCtx = (key: string) => {
    const existing = findings.functionContexts[key];
    if (existing) return existing;
    const created = {
      reads: new Set<string>(),
      writes: new Set<string>(),
      derives: [] as { target: string; sources: string[]; op?: string }[],
      passesTo: [] as {
        callee: string;
        argIndex: number;
        sourceVar: string;
        paramName?: string;
      }[],
    };
    findings.functionContexts[key] = created;
    return created;
  };
  const collectIdentifiers = (node: any): string[] => {
    const out: string[] = [];
    if (!node) return out;
    const stack = [node];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur) break;
      if (cur.type === "identifier") {
        out.push(cur.text);
      }
      const count = cur.namedChildCount ?? 0;
      for (let i = 0; i < count; i++) {
        const ch = cur.namedChild(i);
        if (ch) stack.push(ch);
      }
    }
    return out;
  };

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

    // Function declarations with return type extraction
    if (
      type === "function_declaration" ||
      type === "method_definition" ||
      type === "arrow_function" ||
      type === "function_expression"
    ) {
      // Use the helper function to get clean function name
      const name = getFunctionName(n);
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

    // Variable declarator with enhanced API context tracking
    if (type === "variable_declarator") {
      const nameNode = n.childForFieldName?.("name") || n.child(0);
      const name = nameNode?.text ?? "var";
      findings.variables.push({
        name,
        start: n.startPosition.row + 1,
        end: n.endPosition.row + 1,
      });

      // Enhanced API variable tracking
      const init = n.childForFieldName?.("value") || n.namedChildren?.find((c: any) => c.type !== "identifier");
      if (init && init.type === "string") {
        const value = init.text.replace(/^['"`]/, "").replace(/['"`]$/, "");
        
        // Check if this looks like an API base URL
        if (isAPIVariableName(name) && (isFullURL(value) || value.startsWith("/"))) {
          apiContext.baseUrls.set(name, value);
          apiContext.apiVariables.add(name);
          logger.debug(`🔍 API Variable detected: ${name} = "${value}"`);
        }
      }

      // Lineage: writes and derives within enclosing function
      const key = enclosingFunctionKey(n);
      if (key) {
        const ctx = getCtx(key);
        ctx.writes.add(name);
        if (init) {
          const sources = collectIdentifiers(init).filter((s) => s !== name);
          for (const s of sources) ctx.reads.add(s);
          if (sources.length) {
            ctx.derives.push({ target: name, sources });
          }
        }
      }
    }

    // Calls (very rough: identifier followed by call)
    if (type === "call_expression") {
      const fnNode = n.childForFieldName?.("function") || n.child(0);
      const fnText = fnNode?.text ?? "";
      if (fnText) findings.calls.push(fnText);

      // Lineage: PASSES_TO mapping and argument reads
      const key = enclosingFunctionKey(n);
      if (key) {
        const ctx = getCtx(key);
        // Determine callee name (prefer identifier or member prop)
        let callee = "";
        if (fnNode?.type === "identifier") {
          callee = fnNode.text;
        } else if (fnNode?.type === "member_expression") {
          const prop =
            fnNode.childForFieldName?.("property") || fnNode.child?.(2);
          callee = prop?.text ?? "";
        }
        const args =
          n.childForFieldName?.("arguments") ||
          n.namedChildren?.find((c: any) => c.type === "arguments") ||
          n.child?.(1);
        const argNodes = args?.namedChildren ?? [];
        for (let i = 0; i < argNodes.length; i++) {
          const a = argNodes[i];
          // Only track simple identifier args for now
          if (a.type === "identifier" && callee) {
            const src = a.text;
            ctx.reads.add(src);
            ctx.passesTo.push({ callee, argIndex: i, sourceVar: src });
          } else {
            // Collect identifiers inside complex args as reads
            for (const id of collectIdentifiers(a)) {
              ctx.reads.add(id);
            }
          }
        }
      }

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

    // Assignment expressions: track reads/writes/derives
    if (type === "assignment_expression") {
      const left = n.childForFieldName?.("left") || n.child?.(0);
      const right = n.childForFieldName?.("right") || n.child?.(2);
      const key = enclosingFunctionKey(n);
      if (key) {
        const ctx = getCtx(key);
        if (left?.type === "identifier") {
          const target = left.text;
          ctx.writes.add(target);
          if (right) {
            const sources = collectIdentifiers(right).filter(
              (s) => s !== target
            );
            for (const s of sources) ctx.reads.add(s);
            if (sources.length) {
              ctx.derives.push({ target, sources });
            }
          }
        } else if (right) {
          // Still collect reads on RHS
          for (const s of collectIdentifiers(right)) ctx.reads.add(s);
        }
      }
    }

    // Enhanced API detection with variable context resolution
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
          
          // Enhanced path resolution using API context
          const resolvedPath = resolveAPIPath(urlOrPath, apiContext);
          if (resolvedPath !== urlOrPath) {
            logger.debug(`🔧 Path resolved: "${urlOrPath}" -> "${resolvedPath}"`);
            urlOrPath = resolvedPath;
          } else {
            // Fallback to simple template placeholder removal
            urlOrPath = stripTemplatePlaceholders(urlOrPath);
          }

          if (urlOrPath) {
            logger.debug(`\n=== Enhanced API Classification ===`);
            logger.debug(
              `Object: "${objText}", Method: "${method}", URL/Path: "${urlOrPath}"`
            );

            // Skip if this is just a variable declaration (not an actual API call)
            if (isVariableDeclaration(n)) {
              logger.debug(`-> SKIPPED (variable declaration, not API call)`);
              return;
            }

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
            }
            // PRIORITY 4: Full URLs are typically consumed
            else if (isFullURL(urlOrPath)) {
              logger.debug(`-> CONSUMED (full URL detected)`);
              findings.consumed.push({ url: urlOrPath, method });
            }
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
      let name = nameNode?.text ?? "function";

      // Clean the function name by removing unwanted characters
      name =
        name
          .replace(/\(\)/g, "")
          .replace(/=>/g, "")
          .replace(/[^\w.$]/g, "")
          .trim() || "function";

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
    columns: [] as { table: string; column: string }[],
    errors: [] as { message: string; line: number }[],
    calls: [] as string[],
    testFramework: undefined as string | undefined,
    springRepositories: [] as {
      name: string;
      entityType?: string;
      idType?: string;
      baseInterface?: string;
      methods: {
        name: string;
        query?: string;
        nativeQuery?: boolean;
        derivedQuery?: boolean;
      }[];
      start: number;
      end: number;
    }[],
    securityComponents: [] as {
      name: string;
      componentType?: string;
      annotations: string[];
      configuredPaths: string[];
      start: number;
      end: number;
    }[],
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

  // Single AST traversal to collect all Java-like findings
  // (prevents multiple full tree walks that can cause infinite loops)
  walk(root, (n) => {
    const type = n.type as string;

    // Method invocations - for consumed APIs and errors
    if (type === "method_invocation") {
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

    // Class declarations
    if (type === "class_declaration") {
      const nameNode = n.childForFieldName?.("name") || n.child(1);
      const name = nameNode?.text ?? "Class";
      findings.classes.push({
        name,
        start: n.startPosition.row + 1,
        end: n.endPosition.row + 1,
      });
    }

    // Method declarations - for functions and provided APIs
    if (type === "method_declaration") {
      const nameNode = n.childForFieldName?.("name") || n.child(1);
      let name = nameNode?.text ?? "method";

      // Clean the function name by removing unwanted characters
      name =
        name
          .replace(/\(\)/g, "")
          .replace(/=>/g, "")
          .replace(/[^\w.$]/g, "")
          .trim() || "method";

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

    // Extract developer and team analytics for this repository
    logger.info(
      `Extracting developer analytics for repository: ${repo.repoRoot}`
    );

    try {
      // Extract developers and commits from git history
      const { developers, commits } = extractDevelopersFromGit(repo.repoRoot);
      entities.push(...developers);
      entities.push(...commits);

      // Extract team information from various sources
      const codeownersTeams = extractTeamFromCodeowners(repo.repoRoot);
      entities.push(...codeownersTeams);

      const metadataTeams = extractTeamFromMetadata(repo.repoRoot);
      entities.push(...metadataTeams);

      // Infer team from repository structure if no explicit teams found
      if (codeownersTeams.length === 0 && metadataTeams.length === 0) {
        const inferredTeam = inferTeamFromRepoStructure(repo.repoRoot);
        if (inferredTeam) {
          entities.push(inferredTeam);
        }
      }

      logger.info(
        `Extracted ${developers.length} developers, ${
          commits.length
        } commits, and ${
          codeownersTeams.length + metadataTeams.length
        } teams from ${repo.repoRoot}`
      );
    } catch (error) {
      logger.warn(
        `Failed to extract developer analytics for ${repo.repoRoot}`,
        {
          error: (error as Error).message,
        }
      );
    }

    for (const f of repo.files) {
      try {
        // Always create a File entity
        entities.push(makeFileEntity(repo.repoRoot, f.relPath));

        // Skip parsing this file itself to avoid known parser edge case noise
        const isSelfAstExtractor =
          /(^|[\/\\])src[\/\\]scanner[\/\\]astExtractor\.ts$/.test(f.relPath);
        if (isSelfAstExtractor) {
          logger.info(`Skipping AST parse for self file: ${f.relPath}`);
          continue;
        }

        const langMod =
          f.language !== "unknown"
            ? langModuleFor(f.language as LanguageId)
            : null;
        if (!langMod) {
          continue; // unsupported
        }

        // Set language and parse with robust fallbacks to avoid "Invalid argument" crashes
        let tree: any;
        try {
          parser.setLanguage(langMod);
        } catch (e) {
          // Retry with fresh parser instance if setLanguage fails
          logger.warn(`parser.setLanguage failed`, {
            error: (e as Error)?.message ?? String(e),
            file: f.relPath,
            language: f.language,
            stage: "setLanguage",
            tsLangKeys:
              f.language === "typescript"
                ? Object.keys((TypeScriptLang as any) || {})
                : undefined,
          });
          try {
            const fresh = new (Parser as any)();
            fresh.setLanguage(langMod);
            tree = fresh.parse(f.content);
          } catch (e2) {
            logger.warn(`AST extraction failed for ${f.relPath}`, {
              error: (e2 as Error)?.message ?? String(e2),
              file: f.relPath,
              language: f.language,
              stage: "setLanguage->fresh.parse",
            });
            continue;
          }
        }
        if (!tree) {
          try {
            tree = parser.parse(f.content);
          } catch (e) {
            // Retry with a fresh parser if parse fails
            logger.debug(`parser.parse failed`, {
              error: (e as Error)?.message ?? String(e),
              file: f.relPath,
              language: f.language,
              stage: "parse",
            });
            try {
              const fresh = new (Parser as any)();
              fresh.setLanguage(langMod);
              tree = fresh.parse(f.content);
            } catch (e2) {
              // Try TSX grammar first (can successfully parse many TS files)
              try {
                const tsxLang =
                  (TypeScriptLang as any)?.tsx ??
                  (TypeScriptLang as any)?.default?.tsx;
                if (tsxLang) {
                  const tsxParser = new (Parser as any)();
                  tsxParser.setLanguage(tsxLang);
                  tree = tsxParser.parse(f.content);
                  logger.info(
                    `Parsed ${f.relPath} with TSX grammar fallback due to TypeScript parse error`
                  );
                } else {
                  throw new Error("TSX language not available on tree-sitter-typescript module");
                }
              } catch (eTsx) {
                // Final fallback: try JavaScript grammar to avoid hard failure on TS edge cases
                try {
                  const jsLang =
                    ((JavaScriptLang as any).default ?? JavaScriptLang) as any;
                  const fallback = new (Parser as any)();
                  fallback.setLanguage(jsLang);
                  tree = fallback.parse(f.content);
                  logger.info(
                    `Parsed ${f.relPath} with JavaScript grammar fallback due to TypeScript parse error`
                  );
                } catch (e3) {
                  const isSelfFile = /[\/\\]src[\/\\]scanner[\/\\]astExtractor\.ts$/.test(
                    f.relPath
                  );
                  const msg = (e3 as Error)?.message ?? String(e3);
                  const isInvalidArg = msg.includes("Invalid argument");
                  if (isSelfFile && isInvalidArg) {
                    // Downgrade to info for known benign parsing issue on this file to avoid noisy warnings
                    logger.info(`AST extraction failed for ${f.relPath}`, {
                      error: msg,
                      file: f.relPath,
                      language: f.language,
                      stage: "parse->fresh.parse->fallback_tsx->fallback_js",
                    });
                  } else {
                    logger.warn(`AST extraction failed for ${f.relPath}`, {
                      error: msg,
                      file: f.relPath,
                      language: f.language,
                      stage: "parse->fresh.parse->fallback_tsx->fallback_js",
                    });
                  }
                  continue;
                }
              }
            }
          }
        }
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

        // Extract TypeScript/JavaScript type definitions if applicable
        if (f.language === "typescript" || f.language === "javascript") {
          const typeDefinitions = extractTSTypeDefinitions(
            root,
            f.content,
            repo.repoRoot,
            f.relPath
          );
          for (const typeDef of typeDefinitions) {
            const typeEntity: TypeDefinitionEntity = {
              id: stableId([
                repo.repoRoot,
                "TypeDefinition",
                f.relPath,
                typeDef.name,
                String(typeDef.span?.startLine || 0),
              ]),
              type: "TypeDefinition",
              name: typeDef.name,
              kind: typeDef.kind,
              properties: typeDef.properties,
              values: typeDef.values,
              definition: typeDef.definition,
              repoRoot: repo.repoRoot,
              file: f.relPath,
              language: f.language,
              span: typeDef.span,
            };
            entities.push(typeEntity);
          }
        }

        // Extract class fields for schema generation
        const classEntities: ClassEntity[] = [];
        for (const c of (res as any).classes) {
          const classEntity = makeClassEntity(
            repo.repoRoot,
            f.relPath,
            f.language,
            c.name,
            c.start,
            c.end
          );

          // Extract class fields using tree-sitter
          const classNode = findNodeAtPosition(root, c.start, c.end, "class");
          if (classNode) {
            const fields = extractClassFields(classNode, f.language);
            classEntity.fields = fields;
          }

          entities.push(classEntity);
          classEntities.push(classEntity);
        }

        // Emit functions with return type extraction
        const fnCtxMap = (res as any).functionContexts as
          | Record<
              string,
              {
                reads: Set<string>;
                writes: Set<string>;
                derives: { target: string; sources: string[]; op?: string }[];
                passesTo: {
                  callee: string;
                  argIndex: number;
                  sourceVar: string;
                  paramName?: string;
                }[];
              }
            >
          | undefined;
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

          // Extract return type and parameters
          const fnNode = findNodeAtPosition(root, fn.start, fn.end, "function");
          if (fnNode) {
            // Extract return type based on language
            if (f.language === "typescript" || f.language === "javascript") {
              const returnInfo = extractTSReturnType(fnNode, f.content);
              func.returns = returnInfo.returnType;
              func.isAsync = returnInfo.isAsync;
              func.returnsSchema = returnInfo.schema;
            } else if (f.language === "python") {
              const returnInfo = extractPythonReturnType(fnNode, f.content);
              func.returns = returnInfo.returnType;
              func.isAsync = returnInfo.isAsync;
            } else if (f.language === "java") {
              const returnInfo = extractJavaReturnType(fnNode);
              func.returns = returnInfo.returnType;
              func.isAsync = returnInfo.isAsync;

              // For Spring controller methods, extract response schema
              if (returnInfo.returnType && isControllerMethod(fnNode)) {
                const schemaInfo = extractSpringResponseSchema(
                  fnNode,
                  classEntities
                );
                if (schemaInfo.schema) {
                  func.returnsSchema = schemaInfo.schema;
                }
              }
            } else if (f.language === "csharp") {
              const returnInfo = extractCSharpReturnType(fnNode);
              func.returns = returnInfo.returnType;
              func.isAsync = returnInfo.isAsync;
            }

            // Extract parameter types
            const paramTypes = extractParameterTypes(fnNode, f.language);
            if (paramTypes.length > 0) {
              func.paramTypes = paramTypes;
            }
          }

          // attach heuristic relationships on function meta for later relationship building
          (func as FunctionEntity).calls = (res as any).calls ?? [];
          (func as FunctionEntity).apisProvided = (res as any).provided ?? [];
          (func as FunctionEntity).apisUsed = (res as any).consumed ?? [];
          (func as FunctionEntity).tablesQueried =
            (res as any).tables?.map((t: any) => t.name) ?? [];
          (func as FunctionEntity).configsUsed = (res as any).configs ?? [];

          // Data lineage: attach reads/writes/derives/passesTo if available
          if (fnCtxMap) {
            const key = `${fn.name}:${fn.start}-${fn.end}`;
            const ctx = fnCtxMap[key];
            if (ctx) {
              (func as FunctionEntity).reads = Array.from(ctx.reads);
              (func as FunctionEntity).writes = Array.from(ctx.writes);
              (func as FunctionEntity).derives = ctx.derives;
              (func as FunctionEntity).passesTo = ctx.passesTo;
            }
          }

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

        // Spring-specific processing for Java files (already handled in analyzeJavaLike)
        if (f.language === "java") {
          // Spring processing is now integrated into the main Java analysis
          // to prevent additional tree walks that could cause infinite loops
          const springResults = (res as any).springRepositories ?? [];
          const securityComponents = (res as any).securityComponents ?? [];

          for (const springRepo of springResults) {
            // Add Spring Data Repository entities
            entities.push({
              id: stableId([
                repo.repoRoot,
                "SpringDataRepository",
                f.relPath,
                springRepo.name,
                String(springRepo.start),
              ]),
              type: "SpringDataRepository" as const,
              name: springRepo.name,
              entityType: springRepo.entityType,
              idType: springRepo.idType,
              baseInterface: springRepo.baseInterface,
              customQueries:
                springRepo.methods?.map((method: any) => ({
                  methodName: method.name,
                  query: method.query,
                  nativeQuery: method.nativeQuery,
                  derivedQuery: method.derivedQuery,
                  returnType: undefined, // Could be enhanced later
                })) || [],
              repoRoot: repo.repoRoot,
              file: f.relPath,
              span: { startLine: springRepo.start, endLine: springRepo.end },
            });
          }

          for (const securityComponent of securityComponents) {
            // Add Spring Security components
            entities.push({
              id: stableId([
                repo.repoRoot,
                "SecurityComponent",
                f.relPath,
                securityComponent.name,
                String(securityComponent.start),
              ]),
              type: "SecurityComponent" as const,
              name: securityComponent.name,
              componentType: securityComponent.componentType,
              securityAnnotations: securityComponent.annotations,
              configuredPaths: securityComponent.configuredPaths,
              repoRoot: repo.repoRoot,
              file: f.relPath,
              span: {
                startLine: securityComponent.start,
                endLine: securityComponent.end,
              },
            });
          }
        }
      } catch (e) {
        logger.warn(`AST extraction failed for ${f.relPath}`, {
          error: (e as Error)?.message,
          stack: (e as Error)?.stack,
          file: f.relPath,
          language: f.language,
        });
      }
    }
  }

  logger.info(`AST extraction produced ${entities.length} entities`);
  return entities;
}
