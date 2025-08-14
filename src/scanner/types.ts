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
  | "ErrorMessage";

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
}

export interface FunctionEntity extends EntityBase {
  type: "Function";
  name: string;
  params?: string[];
  returns?: string;
  // relationships (by name) for convenience; relationshipBuilder will convert to edges
  calls?: string[]; // function names
  apisProvided?: { method: string; path: string }[];
  apisUsed?: { method?: string; url: string }[];
  tablesQueried?: string[];
  configsUsed?: string[];
}

export interface VariableEntity extends EntityBase {
  type: "Variable";
  name: string;
}

export interface APIEntity extends EntityBase {
  type: "API";
  name: string; // endpoint name or identifier
  method?: string;
  path?: string;
  url?: string;
  direction: "provided" | "consumed";
  isCorrectlyClassified?: boolean; // Flag for classification correction
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
}

export interface DatabaseColumnEntity extends EntityBase {
  type: "DatabaseColumn";
  name: string; // column name
  table: string; // parent table name
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
  | "SHARES_PACKAGE_WITH";

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
