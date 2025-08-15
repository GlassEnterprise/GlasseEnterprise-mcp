export type LanguageId =
  | "javascript"
  | "typescript"
  | "python"
  | "java"
  | "csharp";

export interface FileInfo {
  repoRoot: string;
  relPath: string;
  absPath: string;
  language: LanguageId | "unknown";
  content: string;
}

export interface RepoFiles {
  repoRoot: string;
  files: FileInfo[];
}

export type EntityType =
  | "Repository"
  | "File"
  | "Class"
  | "Function"
  | "Variable"
  | "API"
  | "Package"
  | "DatabaseTable"
  | "DatabaseColumn"
  | "Config"
  | "Test"
  | "ErrorMessage"
  | "SpringDataRepository"
  | "SecurityComponent"
  | "TypeDefinition"
  | "Developer"
  | "Team"
  | "Commit";

export interface EntityBase {
  id: string; // globally unique stable id
  type: EntityType;
  name?: string;
  repoRoot: string;
  file?: string; // relative file path
  language?: LanguageId | "unknown";
  span?: { startLine: number; endLine: number };
  // optional metadata bag
  meta?: Record<string, unknown>;
}

export interface FileEntity extends EntityBase {
  type: "File";
  file: string;
  size?: number;
}

export interface ClassEntity extends EntityBase {
  type: "Class";
  name: string;
  // Enhanced with field/property information for schema extraction
  fields?: {
    name: string;
    type?: string;
    visibility?: string;
    annotations?: string[];
  }[];
  methods?: {
    name: string;
    returnType?: string;
    parameters?: { name: string; type?: string }[];
  }[];
}

export interface FunctionEntity extends EntityBase {
  type: "Function";
  name: string;
  params?: string[];
  paramTypes?: { name: string; type?: string }[]; // Enhanced parameter types
  returns?: string; // Return type
  returnsSchema?: object; // Detailed return schema for complex types
  isAsync?: boolean; // Whether the function is async/returns a Promise
  // relationships (by name) for convenience; relationshipBuilder will convert to edges
  calls?: string[]; // function names
  apisProvided?: { method: string; path: string }[];
  apisUsed?: { method?: string; url: string }[];
  tablesQueried?: string[];
  configsUsed?: string[];
  // Data lineage metadata (per function)
  reads?: string[]; // variable names read within this function
  writes?: string[]; // variable names written within this function
  derives?: { target: string; sources: string[]; op?: string }[]; // new var derived from sources
  passesTo?: {
    callee: string;
    argIndex: number;
    sourceVar: string;
    paramName?: string;
  }[]; // var passed to callee
  // Spring Data specific
  queryAnnotations?: { query: string; nativeQuery?: boolean }[];
  springDataOperation?: {
    operation: string; // find, delete, count, exists, etc.
    entity?: string;
    fields?: string[];
  };
}

export interface VariableEntity extends EntityBase {
  type: "Variable";
  name: string;
  dataType?: string; // Variable type if available
}

export interface APIEntity extends EntityBase {
  type: "API";
  name: string; // endpoint name or identifier
  method?: string;
  path?: string;
  url?: string;
  direction: "provided" | "consumed";
  isCorrectlyClassified?: boolean; // Flag for classification correction
  // Enhanced schema information
  responseType?: string; // The return type of the API endpoint
  responseSchema?: object; // Detailed schema of the response
  requestSchema?: object; // Schema of the request body
  queryParams?: { name: string; type?: string; required?: boolean }[];
  pathParams?: { name: string; type?: string }[];
  headers?: { name: string; type?: string; required?: boolean }[];
}

export interface TypeDefinitionEntity extends EntityBase {
  type: "TypeDefinition";
  name: string; // Type/Interface/Class name
  kind: "interface" | "type" | "class" | "enum"; // Type of definition
  definition?: object; // The actual type definition structure
  // For interfaces and classes
  properties?: {
    name: string;
    type?: string;
    optional?: boolean;
    visibility?: string;
  }[];
  // For enums
  values?: string[];
  // Generic type parameters
  typeParams?: string[];
  // What it extends/implements
  extends?: string[];
  implements?: string[];
}

export interface PackageEntity extends EntityBase {
  type: "Package";
  name: string; // package/library name
  // We store global package nodes (id includes manager+name), and attach per-repo usage on relationship properties.
  // To enable relationship building, we capture the declaring repo in meta.declaredByRepoRoot and version in meta.version.
  // Optionally, meta.manager specifies the package manager (e.g., "npm", "pip", "maven", "nuget").
}

export interface DatabaseTableEntity extends EntityBase {
  type: "DatabaseTable";
  name: string; // table name
  schema?: string; // optional schema name
  entityClass?: string; // associated JPA entity class name
}

export interface DatabaseColumnEntity extends EntityBase {
  type: "DatabaseColumn";
  name: string; // column name
  table: string; // parent table name
  dataType?: string; // column data type if known
  entityField?: string; // associated entity field name
}

export interface ConfigEntity extends EntityBase {
  type: "Config";
  name: string; // config key name
  valueSample?: string;
}

export interface TestEntity extends EntityBase {
  type: "Test";
  name: string; // test name or file
  framework?: string;
  file: string;
}

export interface RepositoryEntity extends EntityBase {
  type: "Repository";
  name: string; // repository name or path
  repoRoot: string;
}

export interface ErrorMessageEntity extends EntityBase {
  type: "ErrorMessage";
  message: string;
}

export interface SpringDataRepositoryEntity extends EntityBase {
  type: "SpringDataRepository";
  name: string; // repository interface name
  entityType?: string; // entity type from generic parameter
  idType?: string; // ID type from generic parameter
  baseInterface?: string; // JpaRepository, CrudRepository, etc.
  customQueries?: {
    methodName: string;
    query?: string;
    nativeQuery?: boolean;
    derivedQuery?: boolean;
    returnType?: string; // Return type of the query method
  }[];
}

export interface SecurityComponentEntity extends EntityBase {
  type: "SecurityComponent";
  name: string;
  componentType?:
    | "AuthenticationManager"
    | "UserDetailsService"
    | "SecurityConfig"
    | "SecurityFilter";
  securityAnnotations?: string[];
  configuredPaths?: string[];
}

export interface DeveloperEntity extends EntityBase {
  type: "Developer";
  name: string; // Full name of the developer
  email?: string; // Primary email address
  username?: string; // Git username or handle
  aliases?: string[]; // Alternative names/emails used
  primaryLanguages?: string[]; // Languages they work with most
  totalCommits?: number; // Total commit count across all repos
  firstCommit?: string; // ISO date of first commit
  lastCommit?: string; // ISO date of last commit
  teamId?: string; // Reference to team they belong to
}

export interface TeamEntity extends EntityBase {
  type: "Team";
  name: string; // Team name
  description?: string; // Team description
  lead?: string; // Team lead/manager
  size?: number; // Number of team members
  repositories?: string[]; // Repository IDs owned by team
  expertise?: string[]; // Technologies/domains the team specializes in
}

export interface CommitEntity extends EntityBase {
  type: "Commit";
  name: string; // Commit message (first line)
  hash: string; // Full commit hash
  shortHash?: string; // Short commit hash
  message?: string; // Full commit message
  author?: string; // Author name
  authorEmail?: string; // Author email
  timestamp?: string; // ISO timestamp
  additions?: number; // Lines added
  deletions?: number; // Lines deleted
  filesChanged?: string[]; // List of files modified
  parentHashes?: string[]; // Parent commit hashes
}

export type AnyEntity =
  | RepositoryEntity
  | FileEntity
  | ClassEntity
  | FunctionEntity
  | VariableEntity
  | APIEntity
  | PackageEntity
  | DatabaseTableEntity
  | DatabaseColumnEntity
  | ConfigEntity
  | TestEntity
  | ErrorMessageEntity
  | SpringDataRepositoryEntity
  | SecurityComponentEntity
  | TypeDefinitionEntity
  | DeveloperEntity
  | TeamEntity
  | CommitEntity
  | EntityBase;

export type RelationshipType =
  | "CONTAINS"
  | "DECLARES"
  | "HAS_FUNCTION"
  | "CALLS"
  | "USES_API"
  | "PROVIDES_API"
  | "QUERIES"
  | "HAS_COLUMN"
  | "USES_CONFIG"
  | "TESTS"
  | "EMITS_ERROR"
  | "REPO_PROVIDES_API"
  | "REPO_USES_API"
  | "CONSUMES_API_FROM"
  | "REPO_DEPENDS_ON_PACKAGE"
  | "SHARES_PACKAGE_WITH"
  // Data lineage relationships
  | "READS_FROM"
  | "WRITES_TO"
  | "TRANSFORMS"
  | "PASSES_TO"
  | "DERIVES_FROM"
  | "DEPENDS_ON"
  // Spring Data relationships
  | "REPOSITORY_FOR_ENTITY"
  | "REPOSITORY_QUERIES_TABLE"
  | "REPOSITORY_HAS_METHOD"
  // Spring Security relationships
  | "SECURED_BY"
  | "AUTHENTICATES"
  | "PROVIDES_USER_DETAILS"
  | "USES_SECURITY_FILTER"
  // Additional Spring relationships
  | "ACCESSES_TABLE"
  | "QUERIES_COLUMN"
  | "SECURES_API"
  | "USED_BY"
  // Type and schema relationships
  | "RETURNS_TYPE"
  | "USES_TYPE"
  | "IMPLEMENTS_TYPE"
  | "API_RETURNS_TYPE"
  | "API_ACCEPTS_TYPE"
  // Developer and Team relationships
  | "BELONGS_TO"
  | "CONTRIBUTED_TO"
  | "OWNS_REPOSITORY"
  | "COMMITTED"
  | "CONTAINS_COMMIT"
  | "MODIFIED_FILE"
  | "COLLABORATES_WITH"
  | "AUTHORED_BY"
  | "MANAGES_TEAM"
  | "HAS_MEMBER";

export interface Relationship {
  id: string;
  type: RelationshipType;
  fromId: string;
  toId: string;
  properties?: Record<string, unknown>;
}

export interface ExtractResult {
  entities: AnyEntity[];
  relationships: Relationship[];
}
