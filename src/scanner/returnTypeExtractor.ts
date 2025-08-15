import Parser from "tree-sitter";
import { Logger } from "../utils/logger.js";

const logger = new Logger("ReturnTypeExtractor");

/**
 * Extract return type from a TypeScript/JavaScript function node
 */
export function extractTSReturnType(
  fnNode: any,
  code: string
): { returnType?: string; isAsync?: boolean; schema?: object } {
  const result: { returnType?: string; isAsync?: boolean; schema?: object } =
    {};

  // Check if it's an async function
  const asyncKeyword = fnNode.namedChildren?.find(
    (c: any) => c.type === "async"
  );
  if (asyncKeyword || fnNode.text?.startsWith("async")) {
    result.isAsync = true;
  }

  // Look for TypeScript return type annotation (: Type)
  const returnType = fnNode.childForFieldName?.("return_type");
  if (returnType) {
    let typeText = returnType.text;
    // Clean up the type text (remove leading colon if present)
    if (typeText.startsWith(":")) {
      typeText = typeText.substring(1).trim();
    }
    result.returnType = typeText;

    // If it's async and doesn't already have Promise wrapper, add it
    if (result.isAsync && !typeText.includes("Promise")) {
      result.returnType = `Promise<${typeText}>`;
    }
  }

  // Try to extract JSDoc @returns if no TypeScript annotation
  if (!result.returnType) {
    const jsDocMatch = extractJSDocReturn(fnNode, code);
    if (jsDocMatch) {
      result.returnType = jsDocMatch;
    }
  }

  // For arrow functions, check the body for implicit returns
  if (fnNode.type === "arrow_function" && !result.returnType) {
    const body = fnNode.childForFieldName?.("body");
    if (body && body.type !== "statement_block") {
      // This is an implicit return
      result.returnType = inferTypeFromExpression(body);
    }
  }

  return result;
}

/**
 * Extract return type from Python function
 */
export function extractPythonReturnType(
  fnNode: any,
  code: string
): { returnType?: string; isAsync?: boolean } {
  const result: { returnType?: string; isAsync?: boolean } = {};

  // Check if it's an async function
  const asyncKeyword = fnNode.namedChildren?.find(
    (c: any) => c.type === "async"
  );
  if (asyncKeyword) {
    result.isAsync = true;
  }

  // Look for return type annotation (-> Type)
  const returnType = fnNode.childForFieldName?.("return_type");
  if (returnType) {
    let typeText = returnType.text;
    // Clean up (remove arrow if present)
    if (typeText.startsWith("->")) {
      typeText = typeText.substring(2).trim();
    }
    result.returnType = typeText;
  }

  // Try to extract from docstring
  if (!result.returnType) {
    const docstring = extractPythonDocstring(fnNode);
    if (docstring) {
      const returnsMatch = docstring.match(/:returns?:\s*([^\n]+)/i);
      if (returnsMatch) {
        result.returnType = returnsMatch[1].trim();
      }
      const rtypeMatch = docstring.match(/:rtype:\s*([^\n]+)/i);
      if (rtypeMatch) {
        result.returnType = rtypeMatch[1].trim();
      }
    }
  }

  return result;
}

/**
 * Extract return type from Java method
 */
export function extractJavaReturnType(methodNode: any): {
  returnType?: string;
  isAsync?: boolean;
  genericType?: string;
} {
  const result: {
    returnType?: string;
    isAsync?: boolean;
    genericType?: string;
  } = {};

  // Java return type is typically right before the method name
  const typeNode = methodNode.childForFieldName?.("type");
  if (typeNode) {
    result.returnType = typeNode.text;

    // Check for generic types (e.g., List<User>, ResponseEntity<T>)
    if (result.returnType) {
      const genericMatch = result.returnType.match(/^(\w+)<(.+)>$/);
      if (genericMatch) {
        result.genericType = genericMatch[2];

        // Check for async patterns
        if (
          result.returnType.includes("CompletableFuture") ||
          result.returnType.includes("Future") ||
          result.returnType.includes("Mono") ||
          result.returnType.includes("Flux")
        ) {
          result.isAsync = true;
        }
      }
    }
  }

  return result;
}

/**
 * Extract return type from C# method
 */
export function extractCSharpReturnType(methodNode: any): {
  returnType?: string;
  isAsync?: boolean;
} {
  const result: { returnType?: string; isAsync?: boolean } = {};

  // Check for async modifier
  const modifiers = methodNode.childForFieldName?.("modifiers");
  if (modifiers && modifiers.text.includes("async")) {
    result.isAsync = true;
  }

  // C# return type
  const typeNode = methodNode.childForFieldName?.("type");
  if (typeNode) {
    result.returnType = typeNode.text;

    // Check for Task/Task<T> for async methods
    if (result.returnType && result.returnType.includes("Task")) {
      result.isAsync = true;
    }
  }

  return result;
}

/**
 * Extract parameter types from a function/method
 */
export function extractParameterTypes(
  fnNode: any,
  language: string
): Array<{ name: string; type?: string }> {
  const params: Array<{ name: string; type?: string }> = [];

  const parameters = fnNode.childForFieldName?.("parameters");
  if (!parameters) return params;

  const paramNodes = parameters.namedChildren || [];

  for (const param of paramNodes) {
    if (language === "typescript" || language === "javascript") {
      // Handle TypeScript/JavaScript parameters
      if (param.type === "identifier") {
        params.push({ name: param.text });
      } else if (
        param.type === "required_parameter" ||
        param.type === "optional_parameter"
      ) {
        const pattern = param.childForFieldName?.("pattern");
        const type = param.childForFieldName?.("type");
        if (pattern) {
          params.push({
            name: pattern.text,
            type: type?.text,
          });
        }
      }
    } else if (language === "python") {
      // Handle Python parameters
      if (param.type === "identifier") {
        params.push({ name: param.text });
      } else if (param.type === "typed_parameter") {
        const name = param.childForFieldName?.("name");
        const type = param.childForFieldName?.("type");
        if (name) {
          params.push({
            name: name.text,
            type: type?.text,
          });
        }
      }
    } else if (language === "java" || language === "csharp") {
      // Handle Java/C# parameters
      const type = param.childForFieldName?.("type");
      const name = param.childForFieldName?.("name");
      if (name) {
        params.push({
          name: name.text,
          type: type?.text,
        });
      }
    }
  }

  return params;
}

/**
 * Extract type definitions (interfaces, types, classes) from TypeScript/JavaScript
 */
export function extractTSTypeDefinitions(
  root: any,
  code: string,
  repoRoot: string,
  relPath: string
): Array<any> {
  const definitions: Array<any> = [];

  function walk(
    node: any,
    callback: (n: any) => void,
    visited = new Set<string>(),
    depth = 0,
    maxDepth = 500
  ) {
    // Prevent infinite loops by using node position as unique identifier
    const nodeId =
      node?.startPosition && node?.endPosition
        ? `${node.startPosition.row}:${node.startPosition.column}-${node.endPosition.row}:${node.endPosition.column}`
        : `${depth}-${Math.random()}`;

    if (visited.has(nodeId) || depth > maxDepth) {
      return;
    }

    visited.add(nodeId);
    callback(node);

    let count = 0;
    try {
      count =
        typeof node.namedChildCount === "function"
          ? node.namedChildCount()
          : node.namedChildCount ?? 0;
    } catch (e) {
      return;
    }

    const maxChildren = Math.min(count, 100);
    for (let i = 0; i < maxChildren; i++) {
      let child;
      try {
        child =
          typeof node.namedChild === "function" ? node.namedChild(i) : null;
      } catch (e) {
        continue;
      }
      if (child && child !== node) {
        walk(child, callback, visited, depth + 1, maxDepth);
      }
    }
  }

  walk(root, (node) => {
    // TypeScript interface
    if (node.type === "interface_declaration") {
      const name = node.childForFieldName?.("name")?.text;
      if (name) {
        const properties = extractInterfaceProperties(node);
        definitions.push({
          type: "TypeDefinition",
          name,
          kind: "interface",
          properties,
          repoRoot,
          file: relPath,
          span: {
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          },
        });
      }
    }

    // TypeScript type alias
    if (node.type === "type_alias_declaration") {
      const name = node.childForFieldName?.("name")?.text;
      const value = node.childForFieldName?.("value");
      if (name) {
        definitions.push({
          type: "TypeDefinition",
          name,
          kind: "type",
          definition: value?.text,
          repoRoot,
          file: relPath,
          span: {
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          },
        });
      }
    }

    // Enum
    if (node.type === "enum_declaration") {
      const name = node.childForFieldName?.("name")?.text;
      if (name) {
        const values = extractEnumValues(node);
        definitions.push({
          type: "TypeDefinition",
          name,
          kind: "enum",
          values,
          repoRoot,
          file: relPath,
          span: {
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          },
        });
      }
    }
  });

  return definitions;
}

/**
 * Extract schema from Spring controller method for response
 */
export function extractSpringResponseSchema(
  methodNode: any,
  classEntities: any[]
): { responseType?: string; schema?: object } {
  const result: { responseType?: string; schema?: object } = {};

  // Get the return type
  const typeNode = methodNode.childForFieldName?.("type");
  if (typeNode) {
    const returnType = typeNode.text;
    result.responseType = returnType;

    // Check for ResponseEntity wrapper
    const responseEntityMatch = returnType.match(/ResponseEntity<(.+)>/);
    if (responseEntityMatch) {
      const innerType = responseEntityMatch[1];
      result.responseType = innerType;

      // Try to find the class definition for the inner type
      const entityClass = classEntities.find((c) => c.name === innerType);
      if (entityClass && entityClass.fields) {
        result.schema = {
          type: "object",
          properties: entityClass.fields.reduce((acc: any, field: any) => {
            acc[field.name] = { type: field.type || "unknown" };
            return acc;
          }, {}),
        };
      }
    }
  }

  return result;
}

// Helper functions

function extractJSDocReturn(node: any, code: string): string | undefined {
  // Look for JSDoc comment above the function
  const startLine = node.startPosition.row;
  const lines = code.split("\n");

  // Search backwards for JSDoc
  for (let i = startLine - 1; i >= 0 && i > startLine - 10; i--) {
    const line = lines[i];
    if (line.includes("@returns") || line.includes("@return")) {
      const match = line.match(/@returns?\s*\{([^}]+)\}/);
      if (match) {
        return match[1].trim();
      }
    }
    if (line.includes("*/")) {
      break; // End of JSDoc block
    }
  }

  return undefined;
}

function extractPythonDocstring(fnNode: any): string | undefined {
  // First statement in function body might be a docstring
  const body = fnNode.childForFieldName?.("body");
  if (body) {
    const firstStatement = body.namedChild?.(0);
    if (firstStatement?.type === "expression_statement") {
      const expr = firstStatement.namedChild?.(0);
      if (expr?.type === "string") {
        return expr.text.replace(/^['"`]{1,3}|['"`]{1,3}$/g, "");
      }
    }
  }
  return undefined;
}

function inferTypeFromExpression(expr: any): string {
  if (!expr) return "unknown";

  switch (expr.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "true":
    case "false":
      return "boolean";
    case "null":
      return "null";
    case "undefined":
      return "undefined";
    case "array":
      return "Array";
    case "object":
      return "Object";
    case "new_expression":
      const constructor = expr.childForFieldName?.("constructor");
      return constructor?.text || "Object";
    case "call_expression":
      const fn = expr.childForFieldName?.("function");
      if (fn?.text?.includes("Promise")) {
        return "Promise";
      }
      return "unknown";
    default:
      return "unknown";
  }
}

function extractInterfaceProperties(interfaceNode: any): Array<any> {
  const properties: Array<any> = [];
  const body = interfaceNode.childForFieldName?.("body");

  if (body) {
    const members = body.namedChildren || [];
    for (const member of members) {
      if (member.type === "property_signature") {
        const name = member.childForFieldName?.("name")?.text;
        const type = member.childForFieldName?.("type")?.text;
        const optional = member.text.includes("?");

        if (name) {
          properties.push({
            name,
            type: type || "any",
            optional,
          });
        }
      }
    }
  }

  return properties;
}

function extractEnumValues(enumNode: any): string[] {
  const values: string[] = [];
  const body = enumNode.childForFieldName?.("body");

  if (body) {
    const members = body.namedChildren || [];
    for (const member of members) {
      if (member.type === "enum_assignment") {
        const name = member.childForFieldName?.("name")?.text;
        if (name) {
          values.push(name);
        }
      }
    }
  }

  return values;
}

/**
 * Extract class fields/properties for schema generation
 */
export function extractClassFields(
  classNode: any,
  language: string
): Array<{
  name: string;
  type?: string;
  visibility?: string;
  annotations?: string[];
}> {
  const fields: Array<any> = [];

  const body = classNode.childForFieldName?.("body");
  if (!body) return fields;

  const members = body.namedChildren || [];

  for (const member of members) {
    if (language === "java") {
      if (member.type === "field_declaration") {
        const modifiers = member.childForFieldName?.("modifiers");
        const type = member.childForFieldName?.("type");
        const declarator = member.childForFieldName?.("declarator");

        if (declarator) {
          const name =
            declarator.childForFieldName?.("name")?.text || declarator.text;
          const visibility = extractVisibility(modifiers);
          const annotations = extractAnnotations(modifiers);

          fields.push({
            name,
            type: type?.text,
            visibility,
            annotations,
          });
        }
      }
    } else if (language === "typescript" || language === "javascript") {
      if (
        member.type === "public_field_definition" ||
        member.type === "property_signature" ||
        member.type === "field_definition"
      ) {
        const name =
          member.childForFieldName?.("property_name")?.text ||
          member.childForFieldName?.("name")?.text;
        const type = member.childForFieldName?.("type")?.text;

        if (name) {
          fields.push({
            name,
            type: type || "any",
            visibility: "public",
          });
        }
      }
    } else if (language === "python") {
      // In Python, we look for assignments in __init__ method
      if (
        member.type === "function_definition" &&
        member.childForFieldName?.("name")?.text === "__init__"
      ) {
        const body = member.childForFieldName?.("body");
        if (body) {
          extractPythonClassFields(body, fields);
        }
      }
    }
  }

  return fields;
}

function extractVisibility(modifiers: any): string {
  if (!modifiers) return "package-private";
  const text = modifiers.text;
  if (text.includes("public")) return "public";
  if (text.includes("private")) return "private";
  if (text.includes("protected")) return "protected";
  return "package-private";
}

function extractAnnotations(modifiers: any): string[] {
  const annotations: string[] = [];
  if (!modifiers) return annotations;

  const children = modifiers.namedChildren || [];
  for (const child of children) {
    if (child.type === "annotation" || child.type === "marker_annotation") {
      const text = child.text;
      if (text.startsWith("@")) {
        annotations.push(text);
      }
    }
  }

  return annotations;
}

function extractPythonClassFields(bodyNode: any, fields: Array<any>) {
  function walk(
    node: any,
    visited = new Set<string>(),
    depth = 0,
    maxDepth = 100
  ) {
    const nodeId =
      node?.startPosition && node?.endPosition
        ? `${node.startPosition.row}:${node.startPosition.column}-${node.endPosition.row}:${node.endPosition.column}`
        : `${depth}-${Math.random()}`;

    if (visited.has(nodeId) || depth > maxDepth) {
      return;
    }

    visited.add(nodeId);

    if (node.type === "assignment") {
      const left = node.childForFieldName?.("left");
      const right = node.childForFieldName?.("right");

      if (left?.type === "attribute") {
        const obj = left.childForFieldName?.("object");
        const attr = left.childForFieldName?.("attribute");

        if (obj?.text === "self" && attr) {
          fields.push({
            name: attr.text,
            type: inferPythonType(right),
            visibility: attr.text.startsWith("_") ? "private" : "public",
          });
        }
      }
    }

    let count = 0;
    try {
      count =
        typeof node.namedChildCount === "function"
          ? node.namedChildCount()
          : node.namedChildCount ?? 0;
    } catch (e) {
      return;
    }

    const maxChildren = Math.min(count, 50);
    for (let i = 0; i < maxChildren; i++) {
      let child;
      try {
        child =
          typeof node.namedChild === "function" ? node.namedChild(i) : null;
      } catch (e) {
        continue;
      }
      if (child && child !== node) {
        walk(child, visited, depth + 1, maxDepth);
      }
    }
  }

  walk(bodyNode);
}

function inferPythonType(expr: any): string {
  if (!expr) return "Any";

  switch (expr.type) {
    case "string":
      return "str";
    case "integer":
    case "float":
      return "number";
    case "true":
    case "false":
      return "bool";
    case "none":
      return "None";
    case "list":
      return "List";
    case "dictionary":
      return "Dict";
    case "call":
      const fn = expr.childForFieldName?.("function");
      return fn?.text || "Any";
    default:
      return "Any";
  }
}
