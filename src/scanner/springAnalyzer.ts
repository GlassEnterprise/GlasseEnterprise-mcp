/**
 * Spring-specific analysis utilities for Java code
 */

import { Logger } from "../utils/logger.js";

const logger = new Logger("SpringAnalyzer");

/**
 * Parse Spring Data method names to extract operation and entity information
 * Examples:
 * - findByUsername -> {operation: "find", fields: ["username"]}
 * - deleteByIdAndActive -> {operation: "delete", fields: ["id", "active"]}
 * - countByStatusIn -> {operation: "count", fields: ["status"]}
 */
export function parseSpringDataMethodName(methodName: string): {
  operation: string;
  entity?: string;
  fields: string[];
} | null {
  // Spring Data query method patterns
  const patterns = [
    /^(find|read|get|query|search|stream)(One|First|Top|Distinct|All)?By(.+)$/,
    /^(count)(Distinct)?By(.+)$/,
    /^(exists)By(.+)$/,
    /^(delete|remove)(All)?By(.+)$/,
  ];

  for (const pattern of patterns) {
    const match = methodName.match(pattern);
    if (match) {
      const operation = match[1].toLowerCase();
      const fieldsStr = match[match.length - 1];

      // Parse field names from the method suffix
      const fields = parseFieldNames(fieldsStr);

      return {
        operation,
        fields,
      };
    }
  }

  // Simple CRUD operations
  if (/^(save|persist|store|insert|update)/.test(methodName)) {
    return { operation: "save", fields: [] };
  }
  if (/^(delete|remove)/.test(methodName)) {
    return { operation: "delete", fields: [] };
  }
  if (/^(find|get|load|fetch)All$/.test(methodName)) {
    return { operation: "findAll", fields: [] };
  }

  return null;
}

/**
 * Parse field names from Spring Data method suffix
 * Handles And, Or, OrderBy, etc.
 */
function parseFieldNames(fieldsStr: string): string[] {
  const fields: string[] = [];

  // Remove OrderBy clause if present
  const withoutOrder = fieldsStr.split("OrderBy")[0];

  // Split by And/Or
  const parts = withoutOrder.split(/(?:And|Or)/);

  for (const part of parts) {
    // Extract field name (remove operators like In, Between, Like, etc.)
    const fieldName = part
      .replace(
        /(?:In|NotIn|Between|Like|NotLike|Containing|StartingWith|EndingWith|GreaterThan|LessThan|After|Before|IsNull|IsNotNull|True|False)$/,
        ""
      )
      .replace(/^Is/, ""); // Remove leading "Is" (e.g., IsActive -> Active)

    if (fieldName) {
      // Convert to lowercase for first character
      fields.push(fieldName.charAt(0).toLowerCase() + fieldName.slice(1));
    }
  }

  return fields;
}

/**
 * Parse JPQL/HQL query to extract table and column references
 */
export function parseJPQL(query: string): {
  tables: string[];
  columns: string[];
  joins: { from: string; to: string; type: string }[];
} {
  const result = {
    tables: [] as string[],
    columns: [] as string[],
    joins: [] as { from: string; to: string; type: string }[],
  };

  try {
    // Normalize query (remove extra spaces, convert to uppercase for parsing)
    const normalizedQuery = query.replace(/\s+/g, " ").trim();

    // Extract entity names from FROM clause
    const fromMatch = normalizedQuery.match(
      /FROM\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi
    );
    if (fromMatch) {
      fromMatch.forEach((match) => {
        const parts = match.match(/FROM\s+(\w+)/i);
        if (parts) {
          result.tables.push(parts[1]);
        }
      });
    }

    // Extract JOIN clauses
    const joinPattern =
      /(LEFT\s+|RIGHT\s+|INNER\s+)?JOIN\s+(\w+(?:\.\w+)?)\s+(?:AS\s+)?(\w+)?/gi;
    let joinMatch;
    while ((joinMatch = joinPattern.exec(normalizedQuery)) !== null) {
      const joinType = joinMatch[1] ? joinMatch[1].trim() : "INNER";
      const joinPath = joinMatch[2];

      // If it's a path (e.g., u.orders), extract the relationship
      if (joinPath.includes(".")) {
        const [from, to] = joinPath.split(".");
        result.joins.push({ from, to, type: joinType });
      } else {
        result.tables.push(joinPath);
      }
    }

    // Extract column references (simplified - looks for entity.field patterns)
    const columnPattern = /(\w+)\.(\w+)/g;
    let columnMatch;
    while ((columnMatch = columnPattern.exec(normalizedQuery)) !== null) {
      const field = columnMatch[2];
      // Filter out common JPQL keywords
      if (!["class", "size", "length"].includes(field.toLowerCase())) {
        result.columns.push(field);
      }
    }

    // Remove duplicates
    result.tables = [...new Set(result.tables)];
    result.columns = [...new Set(result.columns)];
  } catch (error) {
    logger.warn(`Failed to parse JPQL query: ${query}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}

/**
 * Parse native SQL query to extract table and column references
 */
export function parseSQL(query: string): {
  tables: string[];
  columns: string[];
} {
  const result = {
    tables: [] as string[],
    columns: [] as string[],
  };

  try {
    const normalizedQuery = query.replace(/\s+/g, " ").toUpperCase().trim();

    // Extract table names from FROM clause
    const fromMatch = normalizedQuery.match(
      /FROM\s+([A-Z_]+)(?:\s+(?:AS\s+)?[A-Z_]+)?/
    );
    if (fromMatch) {
      result.tables.push(fromMatch[1]);
    }

    // Extract table names from JOIN clauses
    const joinPattern = /JOIN\s+([A-Z_]+)(?:\s+(?:AS\s+)?[A-Z_]+)?/g;
    let joinMatch;
    while ((joinMatch = joinPattern.exec(normalizedQuery)) !== null) {
      result.tables.push(joinMatch[1]);
    }

    // Extract table names from INSERT INTO, UPDATE, DELETE FROM
    const dmlMatch = normalizedQuery.match(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Z_]+)/
    );
    if (dmlMatch) {
      result.tables.push(dmlMatch[1]);
    }

    // Extract column names from SELECT clause (simplified)
    const selectMatch = normalizedQuery.match(/SELECT\s+(.+?)\s+FROM/);
    if (selectMatch && !selectMatch[1].includes("*")) {
      const columnsPart = selectMatch[1];
      const columns = columnsPart
        .split(",")
        .map((col) => {
          // Remove aliases and table prefixes
          const cleanCol = col
            .trim()
            .split(/\s+AS\s+/)[0]
            .split(".")
            .pop();
          return cleanCol || "";
        })
        .filter(
          (col) =>
            col &&
            !["COUNT", "SUM", "AVG", "MAX", "MIN", "DISTINCT"].includes(col)
        );
      result.columns.push(...columns);
    }

    // Extract column names from WHERE clause (simplified)
    const whereMatch = normalizedQuery.match(
      /WHERE\s+(.+?)(?:\s+(?:GROUP|ORDER|LIMIT)|$)/
    );
    if (whereMatch) {
      const whereClause = whereMatch[1];
      const columnPattern = /([A-Z_]+)\s*(?:=|!=|<>|<|>|<=|>=|LIKE|IN)/g;
      let colMatch;
      while ((colMatch = columnPattern.exec(whereClause)) !== null) {
        const col = colMatch[1];
        if (!["AND", "OR", "NOT", "NULL", "TRUE", "FALSE"].includes(col)) {
          result.columns.push(col);
        }
      }
    }

    // Convert back to proper case and remove duplicates
    result.tables = [...new Set(result.tables.map((t) => t.toLowerCase()))];
    result.columns = [...new Set(result.columns.map((c) => c.toLowerCase()))];
  } catch (error) {
    logger.warn(`Failed to parse SQL query: ${query}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}

/**
 * Check if an interface extends Spring Data repository interfaces
 */
export function isSpringDataRepository(extendsClause: string | undefined): {
  isRepository: boolean;
  baseInterface?: string;
  entityType?: string;
  idType?: string;
} {
  if (!extendsClause) {
    return { isRepository: false };
  }

  const repositoryInterfaces = [
    "JpaRepository",
    "CrudRepository",
    "PagingAndSortingRepository",
    "Repository",
    "MongoRepository",
    "ReactiveCrudRepository",
    "ReactiveMongoRepository",
    "ElasticsearchRepository",
  ];

  for (const repoInterface of repositoryInterfaces) {
    if (extendsClause.includes(repoInterface)) {
      // Extract generic parameters
      const genericMatch = extendsClause.match(
        new RegExp(`${repoInterface}\\s*<\\s*([^,>]+)\\s*,\\s*([^>]+)\\s*>`)
      );
      if (genericMatch) {
        return {
          isRepository: true,
          baseInterface: repoInterface,
          entityType: genericMatch[1].trim(),
          idType: genericMatch[2].trim(),
        };
      }
      return {
        isRepository: true,
        baseInterface: repoInterface,
      };
    }
  }

  return { isRepository: false };
}

/**
 * Extract entity class information from @Entity annotations
 */
export function extractEntityInfo(classText: string): {
  isEntity: boolean;
  tableName?: string;
  schemaName?: string;
} {
  if (!classText.includes("@Entity")) {
    return { isEntity: false };
  }

  const result: any = { isEntity: true };

  // Extract @Table annotation
  const tableMatch = classText.match(/@Table\s*\([^)]*\)/);
  if (tableMatch) {
    const tableAnnotation = tableMatch[0];

    // Extract table name
    const nameMatch = tableAnnotation.match(/name\s*=\s*"([^"]+)"/);
    if (nameMatch) {
      result.tableName = nameMatch[1];
    }

    // Extract schema name
    const schemaMatch = tableAnnotation.match(/schema\s*=\s*"([^"]+)"/);
    if (schemaMatch) {
      result.schemaName = schemaMatch[1];
    }
  }

  return result;
}

/**
 * Check if a class is a Spring Security component
 */
export function detectSpringSecurityComponent(
  classText: string,
  className: string
): {
  isSecurityComponent: boolean;
  componentType?:
    | "AuthenticationManager"
    | "UserDetailsService"
    | "SecurityConfig"
    | "SecurityFilter";
  annotations: string[];
} {
  const annotations: string[] = [];
  const securityAnnotations = [
    "@EnableWebSecurity",
    "@EnableGlobalMethodSecurity",
    "@EnableMethodSecurity",
    "@PreAuthorize",
    "@PostAuthorize",
    "@Secured",
    "@RolesAllowed",
  ];

  // Check for security annotations
  for (const annotation of securityAnnotations) {
    if (classText.includes(annotation)) {
      annotations.push(annotation);
    }
  }

  // Detect component type
  let componentType:
    | "AuthenticationManager"
    | "UserDetailsService"
    | "SecurityConfig"
    | "SecurityFilter"
    | undefined;

  if (classText.includes("implements UserDetailsService")) {
    componentType = "UserDetailsService";
  } else if (
    classText.includes("AuthenticationManager") &&
    classText.includes("@Bean")
  ) {
    componentType = "AuthenticationManager";
  } else if (
    classText.includes("extends OncePerRequestFilter") ||
    classText.includes("extends GenericFilterBean") ||
    className.includes("Filter")
  ) {
    componentType = "SecurityFilter";
  } else if (
    annotations.some((a) => a.includes("EnableWebSecurity")) ||
    (classText.includes("@Configuration") && className.includes("Security"))
  ) {
    componentType = "SecurityConfig";
  }

  return {
    isSecurityComponent: annotations.length > 0 || componentType !== undefined,
    componentType,
    annotations,
  };
}

/**
 * Extract security configuration paths from method calls
 */
export function extractSecurityPaths(methodText: string): string[] {
  const paths: string[] = [];

  // Look for antMatchers, mvcMatchers, requestMatchers patterns
  const patterns = [
    /antMatchers\s*\(\s*"([^"]+)"/g,
    /mvcMatchers\s*\(\s*"([^"]+)"/g,
    /requestMatchers\s*\(\s*"([^"]+)"/g,
    /authorizeRequests\s*\(\s*\)\.antMatchers\s*\(\s*"([^"]+)"/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(methodText)) !== null) {
      paths.push(match[1]);
    }
  }

  return [...new Set(paths)];
}
