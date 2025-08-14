import { readFile } from "fs/promises";
import { join, relative } from "path";
import { glob } from "glob";
import { createHash } from "crypto";
import { AnyEntity, PackageEntity } from "./types.js";
import { Logger } from "../utils/logger.js";

const logger = new Logger("DependencyExtractor");

// Helper to create stable, cross-repo IDs for shared packages
function stableId(parts: string[]): string {
  return createHash("md5").update(parts.join("|")).digest("hex");
}

// Create a PackageEntity
function makePackageEntity(params: {
  repoRoot: string;
  manager: "npm" | "pip" | "maven" | "go" | "nuget";
  name: string;
  version?: string | null;
  file?: string | null;
}): PackageEntity {
  const { repoRoot, manager, name, version, file } = params;
  const id = stableId(["Package", manager, name]);
  const ent: PackageEntity = {
    id,
    type: "Package",
    name,
    repoRoot,
    file: file ?? undefined,
    meta: {
      manager,
      version: version ?? undefined,
      declaredByRepoRoot: repoRoot,
    },
  };
  return ent;
}

// Parse helpers
function parseRequirementsTxt(
  content: string
): { name: string; version?: string }[] {
  const out: { name: string; version?: string }[] = [];
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Examples:
    // package==1.2.3
    // package>=1.0
    // package~=2.0
    // package
    const m = line.match(/^([A-Za-z0-9._\-]+)\s*(?:([=~!<>]{1,2}).*)?$/);
    if (m) {
      const name = m[1];
      // very naive version extraction
      const verMatch =
        line.match(/==\s*([^\s#]+)/) ||
        line.match(/>=\s*([^\s#]+)/) ||
        line.match(/~=\s*([^\s#]+)/) ||
        line.match(/=\s*([^\s#]+)/);
      out.push({ name, version: verMatch ? verMatch[1] : undefined });
    }
  }
  return out;
}

function extractStringsFromArrayLiteral(toml: string): string[] {
  // Extract quoted strings inside an array like ["a", "b>=1.0"]
  const arrMatch = toml.match(
    /\[\s*("[^"]*"|'[^']*')(?:\s*,\s*("[^"]*"|'[^']*'))*\s*\]/
  );
  if (!arrMatch) return [];
  const segment = arrMatch[0];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) {
    out.push((m[1] ?? m[2]) as string);
  }
  return out;
}

function parsePyProjectToml(
  content: string
): { name: string; version?: string }[] {
  // Very naive: look for "dependencies = [ ... ]" in [project] or [tool.poetry]
  // and split strings of form "packagename(==|>=|~=)version" or just "packagename"
  const results: { name: string; version?: string }[] = [];

  // Match a dependencies array
  const depsBlocks = content.match(/dependencies\s*=\s*\[[\s\S]*?\]/g) || [];
  for (const block of depsBlocks) {
    const items = extractStringsFromArrayLiteral(block);
    for (const item of items) {
      // Remove extras in parentheses, e.g. package[extra]
      const cleaned = item.replace(/\[[^\]]*\]/g, "");
      const mVer =
        cleaned.match(/^\s*([A-Za-z0-9._\-]+)\s*==\s*([^\s]+)\s*$/) ||
        cleaned.match(/^\s*([A-Za-z0-9._\-]+)\s*>=\s*([^\s]+)\s*$/) ||
        cleaned.match(/^\s*([A-Za-z0-9._\-]+)\s*~=\s*([^\s]+)\s*$/) ||
        cleaned.match(/^\s*([A-Za-z0-9._\-]+)\s*=\s*([^\s]+)\s*$/);
      if (mVer) {
        results.push({ name: mVer[1], version: mVer[2] });
      } else {
        const mName = cleaned.match(/^\s*([A-Za-z0-9._\-]+)\s*$/);
        if (mName) results.push({ name: mName[1] });
      }
    }
  }

  return results;
}

function parsePomXml(content: string): { name: string; version?: string }[] {
  // Naive parse: find <dependency> blocks and extract groupId, artifactId, version
  const out: { name: string; version?: string }[] = [];
  const depRe = /<dependency>([\s\S]*?)<\/dependency>/g;
  let m: RegExpExecArray | null;
  while ((m = depRe.exec(content))) {
    const block = m[1];
    const g = block.match(/<groupId>([^<]+)<\/groupId>/);
    const a = block.match(/<artifactId>([^<]+)<\/artifactId>/);
    const v = block.match(/<version>([^<]+)<\/version>/);
    const groupId =
      g?.[1] ||
      (block.match(/<groupId>([\s\S]*?)<\/groupId>/)?.[1] ?? "").trim();
    const artifactId =
      a?.[1] ||
      (block.match(/<artifactId>([\s\S]*?)<\/artifactId>/)?.[1] ?? "").trim();
    const version =
      v?.[1] ||
      (block.match(/<version>([\s\S]*?)<\/version>/)?.[1] ?? "").trim() ||
      undefined;
    if (groupId && artifactId) {
      out.push({ name: `${groupId}:${artifactId}`, version });
    }
  }

  // Also handle normal XML if raw < and > are not escaped
  const depRe2 = /<dependency>([\s\S]*?)<\/dependency>/g;
  while ((m = depRe2.exec(content))) {
    const block = m[1];
    const g = block.match(/<groupId>([^<]+)<\/groupId>/);
    const a = block.match(/<artifactId>([^<]+)<\/artifactId>/);
    const v = block.match(/<version>([^<]+)<\/version>/);
    const groupId = g?.[1]?.trim();
    const artifactId = a?.[1]?.trim();
    const version = v?.[1]?.trim();
    if (groupId && artifactId) {
      out.push({ name: `${groupId}:${artifactId}`, version });
    }
  }

  return out;
}

function parseGoMod(content: string): { name: string; version?: string }[] {
  const out: { name: string; version?: string }[] = [];
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    // require github.com/pkg/errors v0.9.1
    const m = line.match(/^require\s+([^\s]+)\s+([^\s]+)$/);
    if (m) {
      out.push({ name: m[1], version: m[2] });
      continue;
    }
    // Within require (...) blocks
    const m2 = line.match(/^([^\s]+)\s+v[0-9][^\s]*$/);
    if (m2) {
      out.push({ name: m2[1], version: line.split(/\s+/)[1] });
    }
  }
  return out;
}

function parseCsProj(content: string): { name: string; version?: string }[] {
  const out: { name: string; version?: string }[] = [];
  const re =
    /<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    out.push({ name: m[1], version: m[2] });
  }
  // Also handle element form:
  // <PackageReference Include="X"><Version>1.2.3</Version></PackageReference>
  const re2 =
    /<PackageReference\s+Include="([^"]+)"[\s\S]*?<Version>([^<]+)<\/Version>[\s\S]*?<\/PackageReference>/g;
  while ((m = re2.exec(content))) {
    out.push({ name: m[1], version: m[2] });
  }
  return out;
}

async function extractFromNpm(repoRoot: string): Promise<PackageEntity[]> {
  const filePath = join(repoRoot, "package.json");
  try {
    const raw = await readFile(filePath, "utf-8");
    const pkg = JSON.parse(raw);
    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
      ...(pkg.optionalDependencies || {}),
    } as Record<string, string>;
    const relFile = relative(repoRoot, filePath);
    return Object.entries(deps).map(([name, version]) =>
      makePackageEntity({
        repoRoot,
        manager: "npm",
        name,
        version,
        file: relFile,
      })
    );
  } catch {
    return [];
  }
}

async function extractFromRequirements(
  repoRoot: string
): Promise<PackageEntity[]> {
  const filePath = join(repoRoot, "requirements.txt");
  try {
    const raw = await readFile(filePath, "utf-8");
    const items = parseRequirementsTxt(raw);
    const relFile = relative(repoRoot, filePath);
    return items.map((i) =>
      makePackageEntity({
        repoRoot,
        manager: "pip",
        name: i.name,
        version: i.version,
        file: relFile,
      })
    );
  } catch {
    return [];
  }
}

async function extractFromPyProject(
  repoRoot: string
): Promise<PackageEntity[]> {
  const filePath = join(repoRoot, "pyproject.toml");
  try {
    const raw = await readFile(filePath, "utf-8");
    const items = parsePyProjectToml(raw);
    const relFile = relative(repoRoot, filePath);
    return items.map((i) =>
      makePackageEntity({
        repoRoot,
        manager: "pip",
        name: i.name,
        version: i.version,
        file: relFile,
      })
    );
  } catch {
    return [];
  }
}

async function extractFromPomXmls(repoRoot: string): Promise<PackageEntity[]> {
  // Look for pom.xml at root and submodules
  const paths = await glob("**/pom.xml", {
    cwd: repoRoot,
    ignore: ["**/target/**", "**/.git/**", "**/node_modules/**"],
    nodir: true,
  });
  const out: PackageEntity[] = [];
  for (const rel of paths) {
    try {
      const raw = await readFile(join(repoRoot, rel), "utf-8");
      const items = parsePomXml(raw);
      out.push(
        ...items.map((i) =>
          makePackageEntity({
            repoRoot,
            manager: "maven",
            name: i.name,
            version: i.version,
            file: rel,
          })
        )
      );
    } catch {
      // ignore individual failures
    }
  }
  return out;
}

async function extractFromGoMod(repoRoot: string): Promise<PackageEntity[]> {
  const filePath = join(repoRoot, "go.mod");
  try {
    const raw = await readFile(filePath, "utf-8");
    const items = parseGoMod(raw);
    const relFile = relative(repoRoot, filePath);
    return items.map((i) =>
      makePackageEntity({
        repoRoot,
        manager: "go",
        name: i.name,
        version: i.version,
        file: relFile,
      })
    );
  } catch {
    return [];
  }
}

async function extractFromCsProj(repoRoot: string): Promise<PackageEntity[]> {
  const paths = await glob("**/*.csproj", {
    cwd: repoRoot,
    ignore: ["**/bin/**", "**/obj/**", "**/.git/**", "**/node_modules/**"],
    nodir: true,
  });
  const out: PackageEntity[] = [];
  for (const rel of paths) {
    try {
      const raw = await readFile(join(repoRoot, rel), "utf-8");
      const items = parseCsProj(raw);
      out.push(
        ...items.map((i) =>
          makePackageEntity({
            repoRoot,
            manager: "nuget",
            name: i.name,
            version: i.version,
            file: rel,
          })
        )
      );
    } catch {
      // ignore
    }
  }
  return out;
}

export async function extractDependencies(
  roots: string[]
): Promise<AnyEntity[]> {
  const all: AnyEntity[] = [];
  for (const root of roots) {
    try {
      const npm = await extractFromNpm(root);
      const pip = [
        ...(await extractFromRequirements(root)),
        ...(await extractFromPyProject(root)),
      ];
      const maven = await extractFromPomXmls(root);
      const go = await extractFromGoMod(root);
      const nuget = await extractFromCsProj(root);

      const total =
        npm.length + pip.length + maven.length + go.length + nuget.length;
      logger.info(
        `[DEPENDENCIES] ${root}: npm=${npm.length}, pip=${pip.length}, maven=${maven.length}, go=${go.length}, nuget=${nuget.length}, total=${total}`
      );

      all.push(...npm, ...pip, ...maven, ...go, ...nuget);
    } catch (e) {
      logger.warn(`[DEPENDENCIES] Failed for ${root}`, {
        error: (e as Error)?.message,
      });
    }
  }

  // Deduplicate per repo to preserve repo-specific usage for relationship building.
  // Use a composite key so each repo's dependency is retained, while Neo4j MERGE ensures one Package node.
  const unique = new Map<string, AnyEntity>();
  for (const e of all) {
    const key = `${e.id}|${(e as any).repoRoot}|${(e as any).file ?? ""}`;
    if (!unique.has(key)) {
      unique.set(key, e);
    }
  }
  return Array.from(unique.values());
}
