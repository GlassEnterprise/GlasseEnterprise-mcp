/**
 * Enhanced Java/Spring analysis functions
 */

import { createHash } from "crypto";
import {
  SpringDataRepositoryEntity,
  SecurityComponentEntity,
  DatabaseTableEntity,
  DatabaseColumnEntity,
} from "./types.js";
import {
  parseSpringDataMethodName,
  parseJPQL,
  parseSQL,
  isSpringDataRepository,
  detectSpringSecurityComponent,
  extractSecurityPaths,
} from "./springAnalyzer.js";

function stableId(parts: string[]): string {
  return createHash("md5").update(parts.join("|")).digest("hex");
}

export function makeSpringDataRepository(
  repoRoot: string,
  relPath: string,
  name: string,
  startLine: number,
  endLine: number,
  entityType?: string,
  idType?: string,
  baseInterface?: string
): SpringDataRepositoryEntity {
  return {
    id: stableId([repoRoot, "SpringDataRepository", relPath, name]),
    type: "SpringDataRepository",
    name,
    entityType,
    idType,
    baseInterface,
    repoRoot,
    file: relPath,
    language: "java",
    span: { startLine, endLine },
  };
}

export function makeSecurityComponent(
  repoRoot: string,
  relPath: string,
  name: string,
  annotations: string[],
  startLine: number,
  endLine: number,
  componentType?:
    | "AuthenticationManager"
    | "UserDetailsService"
    | "SecurityConfig"
    | "SecurityFilter"
): SecurityComponentEntity {
  return {
    id: stableId([repoRoot, "SecurityComponent", relPath, name]),
    type: "SecurityComponent",
    name,
    componentType,
    securityAnnotations: annotations,
    repoRoot,
    file: relPath,
    language: "java",
    span: { startLine, endLine },
  };
}

export function makeTableEntity(
  repoRoot: string,
  relPath: string,
  table: string,
  schema?: string,
  entityClass?: string
): DatabaseTableEntity {
  return {
    id: stableId([repoRoot, "DatabaseTable", table]),
    type: "DatabaseTable",
    name: table,
    schema,
    entityClass,
    repoRoot,
    file: relPath,
  };
}

export function makeColumnEntity(
  repoRoot: string,
  relPath: string,
  table: string,
  column: string,
  dataType?: string,
  entityField?: string
): DatabaseColumnEntity {
  return {
    id: stableId([repoRoot, "DatabaseColumn", table, column]),
    type: "DatabaseColumn",
    name: column,
    table,
    dataType,
    entityField,
    repoRoot,
    file: relPath,
  };
}

/**
 * Process a Spring Data repository interface
 */
export function processSpringDataRepository(
  node: any,
  code: string,
  repoRoot: string,
  relPath: string
): {
  repository?: SpringDataRepositoryEntity;
  tables: DatabaseTableEntity[];
  columns: DatabaseColumnEntity[];
} {
  const result = {
    repository: undefined as SpringDataRepositoryEntity | undefined,
    tables: [] as DatabaseTableEntity[],
    columns: [] as DatabaseColumnEntity[],
  };

  // Get interface name
  const nameNode = node.childForFieldName?.("name") || node.child?.(1);
  const name = nameNode?.text ?? "Repository";

  // Check if it extends Spring Data repository
  const superInterfaces =
    node.childForFieldName?.("extends_interfaces") ||
    node.namedChildren?.find((c: any) => c.type === "extends_interfaces") ||
    node.childForFieldName?.("superInterfaces") ||
    node.namedChildren?.find((c: any) => c.type === "super_interfaces");

  if (!superInterfaces) {
    // Try to find the extends clause manually
    const nodeText = node.text;
    if (nodeText && nodeText.includes("extends")) {
      const extendsMatch = nodeText.match(/extends\s+([^{]+)/);
      if (extendsMatch) {
        const extendsText = extendsMatch[1].trim();
        const repoInfo = isSpringDataRepository(extendsText);

        if (repoInfo.isRepository) {
          // Create repository entity
          const repository = makeSpringDataRepository(
            repoRoot,
            relPath,
            name,
            node.startPosition.row + 1,
            node.endPosition.row + 1,
            repoInfo.entityType,
            repoInfo.idType,
            repoInfo.baseInterface
          );
          result.repository = repository;

          // If we have an entity type, create table entity
          if (repoInfo.entityType) {
            const tableName = repoInfo.entityType.toLowerCase() + "s";
            result.tables.push(
              makeTableEntity(
                repoRoot,
                relPath,
                tableName,
                undefined,
                repoInfo.entityType
              )
            );
          }
        }
      }
    }
    return result;
  }

  const extendsText = superInterfaces.text;
  const repoInfo = isSpringDataRepository(extendsText);

  if (!repoInfo.isRepository) {
    return result;
  }

  // Create repository entity
  const repository = makeSpringDataRepository(
    repoRoot,
    relPath,
    name,
    node.startPosition.row + 1,
    node.endPosition.row + 1,
    repoInfo.entityType,
    repoInfo.idType,
    repoInfo.baseInterface
  );

  result.repository = repository;

  // If we have an entity type, create table entity
  if (repoInfo.entityType) {
    const tableName = repoInfo.entityType.toLowerCase() + "s"; // Simple pluralization
    result.tables.push(
      makeTableEntity(
        repoRoot,
        relPath,
        tableName,
        undefined,
        repoInfo.entityType
      )
    );
  }

  // Process repository methods for queries
  const body =
    node.childForFieldName?.("body") ||
    node.namedChildren?.find((c: any) => c.type === "interface_body");

  if (body) {
    // Look for method declarations
    const methods =
      body.namedChildren?.filter(
        (c: any) =>
          c.type === "method_declaration" ||
          c.type === "abstract_method_declaration"
      ) || [];

    for (const method of methods) {
      const methodName =
        method.childForFieldName?.("name")?.text || method.child?.(1)?.text;

      if (methodName) {
        // Check for Spring Data query methods
        const queryInfo = parseSpringDataMethodName(methodName);
        if (queryInfo && queryInfo.fields.length > 0) {
          // Create columns from field names
          for (const field of queryInfo.fields) {
            if (repoInfo.entityType) {
              const tableName = repoInfo.entityType.toLowerCase() + "s";
              result.columns.push(
                makeColumnEntity(
                  repoRoot,
                  relPath,
                  tableName,
                  field,
                  undefined,
                  field
                )
              );
            }
          }
        }

        // Check for @Query annotations
        const modifiers =
          method.childForFieldName?.("modifiers") ||
          method.namedChildren?.find((c: any) => c.type === "modifiers");

        if (modifiers) {
          const annotations =
            modifiers.namedChildren?.filter(
              (c: any) =>
                c.type === "annotation" || c.type === "marker_annotation"
            ) || [];

          for (const anno of annotations) {
            const annoText = anno.text;
            if (annoText && annoText.includes("@Query")) {
              // Extract query string
              const queryMatch = annoText.match(
                /@Query\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/
              );
              if (queryMatch) {
                const query = queryMatch[1];
                const isNative =
                  annoText.includes("nativeQuery") && annoText.includes("true");

                // Parse the query
                const parsed = isNative ? parseSQL(query) : parseJPQL(query);

                // Create table entities from parsed tables
                for (const table of parsed.tables) {
                  result.tables.push(
                    makeTableEntity(repoRoot, relPath, table.toLowerCase())
                  );
                }

                // Create column entities from parsed columns
                for (const column of parsed.columns) {
                  // Try to guess table from context
                  const tableName =
                    parsed.tables[0]?.toLowerCase() ||
                    repoInfo.entityType?.toLowerCase() + "s" ||
                    "unknown";
                  result.columns.push(
                    makeColumnEntity(
                      repoRoot,
                      relPath,
                      tableName,
                      column.toLowerCase()
                    )
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  // Add customQueries to repository
  if (repository && result.columns.length > 0) {
    repository.customQueries = result.columns.map((col) => ({
      methodName: `findBy${
        col.name.charAt(0).toUpperCase() + col.name.slice(1)
      }`,
      derivedQuery: true,
    }));
  }

  return result;
}

/**
 * Process a Spring Security component class
 */
export function processSpringSecurityComponent(
  node: any,
  code: string,
  repoRoot: string,
  relPath: string
): SecurityComponentEntity | null {
  // Get class name
  const nameNode = node.childForFieldName?.("name") || node.child?.(1);
  const name = nameNode?.text ?? "SecurityClass";

  // Get the full class text for analysis
  const startOffset = node.startIndex ?? 0;
  const endOffset = node.endIndex ?? code.length;
  const classText = code.slice(startOffset, endOffset);

  // Detect if it's a security component
  const securityInfo = detectSpringSecurityComponent(classText, name);

  if (!securityInfo.isSecurityComponent) return null;

  // Create security component entity
  const component = makeSecurityComponent(
    repoRoot,
    relPath,
    name,
    securityInfo.annotations,
    node.startPosition.row + 1,
    node.endPosition.row + 1,
    securityInfo.componentType
  );

  // Extract configured paths from security configuration
  if (securityInfo.componentType === "SecurityConfig") {
    const paths = extractSecurityPaths(classText);
    if (paths.length > 0) {
      component.configuredPaths = paths;
    }
  }

  return component;
}
