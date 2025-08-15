import { Driver } from "neo4j-driver";
import { AnyEntity, EntityType } from "../scanner/types.js";
import { Logger } from "../utils/logger.js";

const logger = new Logger("SaveNodes");

function labelFor(type: EntityType): string {
  return type;
}

function serializeMeta(
  meta?: Record<string, unknown>
): Record<string, unknown> {
  if (!meta) return {};
  // Neo4j properties must be primitives or arrays; stringify nested objects
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v;
    } else {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

export async function upsertEntitiesBatch(
  driver: Driver,
  entities: AnyEntity[],
  snapshotVersion?: string
): Promise<void> {
  if (!entities.length) return;

  const session = driver.session();
  try {
    // Group entities by type to handle each separately
    const byType = new Map<EntityType, AnyEntity[]>();
    for (const entity of entities) {
      if (!byType.has(entity.type)) {
        byType.set(entity.type, []);
      }
      byType.get(entity.type)!.push(entity);
    }

    // Handle API entities specially to ensure correct direction storage
    if (byType.has("API")) {
      const apiEntities = byType.get("API")! as (AnyEntity & {
        direction?: string;
        method?: string;
        url?: string;
        path?: string;
        meta?: Record<string, unknown>;
        span?: { startLine: number; endLine: number };
        language?: string;
        file?: string;
        repoRoot: string;
        name?: string;
        type: string;
        id: string;
      })[];

      // DEBUG: Log API entities before storage
      logger.debug("=== API ENTITIES BEFORE STORAGE ===");
      const consumed = apiEntities.filter((e) => e.direction === "consumed");
      const provided = apiEntities.filter((e) => e.direction === "provided");
      logger.debug(
        `Found ${consumed.length} consumed APIs, ${provided.length} provided APIs`
      );
      if (consumed.length > 0) {
        logger.debug(
          `Sample consumed API: ${JSON.stringify(consumed[0], null, 2)}`
        );
      }
      if (provided.length > 0) {
        logger.debug(
          `Sample provided API: ${JSON.stringify(provided[0], null, 2)}`
        );
      }

      // Deduplicate API entities within the current batch by stable id
      const uniqueById = new Map<string, (typeof apiEntities)[number]>();
      for (const e of apiEntities) {
        const existing = uniqueById.get(e.id);
        if (!existing) {
          uniqueById.set(e.id, { ...e });
        } else {
          // Merge non-null/undefined properties, prefer existing non-null
          existing.method = existing.method ?? e.method;
          existing.path = existing.path ?? e.path;
          existing.url = existing.url ?? e.url;
          existing.name = existing.name ?? e.name;
          existing.file = existing.file ?? e.file;
          existing.language = existing.language ?? e.language;
          existing.span = existing.span ?? e.span;
          if (e.meta) {
            existing.meta = { ...(existing.meta || {}), ...e.meta };
          }
        }
      }

      const apiRows = Array.from(uniqueById.values()).map((e) => ({
        id: e.id,
        type: e.type,
        name: e.name ?? null,
        repoRoot: e.repoRoot,
        file: e.file ?? null,
        language: e.language ?? null,
        spanStart: e.span?.startLine ?? null,
        spanEnd: e.span?.endLine ?? null,
        direction: e.direction ?? null,
        method: e.method ?? null,
        path: e.path ?? null,
        url: e.url ?? null,
        snapshotVersion: snapshotVersion ?? null,
        // Store metadata as JSON string to satisfy Neo4j property constraints
        metaJson: e.meta ? JSON.stringify(serializeMeta(e.meta)) : null,
      }));

      // DEBUG: Log rows being sent to Neo4j
      logger.debug("=== ROWS BEING SENT TO NEO4J ===");
      const consumedRows = apiRows.filter((r) => r.direction === "consumed");
      const providedRows = apiRows.filter((r) => r.direction === "provided");
      logger.debug(
        `Sending ${consumedRows.length} consumed API rows, ${providedRows.length} provided API rows`
      );
      if (consumedRows.length > 0) {
        logger.debug(
          `Sample consumed row: ${JSON.stringify(consumedRows[0], null, 2)}`
        );
      }

      const apiQuery = `
        UNWIND $rows AS row
        MERGE (api:API {id: row.id})
        ON CREATE SET api.createdAt = timestamp()
        SET api.type = row.type,
            api.name = row.name,
            api.repoRoot = row.repoRoot,
            api.file = row.file,
            api.language = row.language,
            api.spanStart = row.spanStart,
            api.spanEnd = row.spanEnd,
            api.direction = row.direction,
            api.method = row.method,
            api.path = row.path,
            api.url = row.url,
            api.metaJson = row.metaJson,
            api.snapshotVersion = row.snapshotVersion,
            api.updatedAt = timestamp()
        RETURN count(api) as count
      `;

      await session.run(apiQuery, { rows: apiRows });
      byType.delete("API");
    }

    // Handle other entity types with generic approach
    for (const [type, group] of byType) {
      const rows = group.map(
        (e: AnyEntity & { meta?: Record<string, unknown> }) => ({
          id: e.id,
          type: e.type,
          name: e.name ?? null,
          repoRoot: e.repoRoot,
          file: (e as any).file ?? null,
          language: (e as any).language ?? null,
          spanStart: (e as any).span?.startLine ?? null,
          spanEnd: (e as any).span?.endLine ?? null,
          snapshotVersion: snapshotVersion ?? null,
          // Store metadata as JSON string (not as a map property)
          metaJson: e.meta ? JSON.stringify(serializeMeta(e.meta)) : null,
          // type-specific projections
          size: (e as any).size ?? null,
          params: (e as any).params ?? null,
          returns: (e as any).returns ?? null,
          table: (e as any).table ?? null,
          valueSample: (e as any).valueSample ?? null,
          framework: (e as any).framework ?? null,
          message: (e as any).message ?? null,
        })
      );

      const query = `
        UNWIND $rows AS row
        CALL apoc.merge.node(['${type}'], {id: row.id}, row, {updatedAt: timestamp()})
        YIELD node
        SET node.snapshotVersion = row.snapshotVersion
        RETURN count(node) as count
      `;

      await session.run(query, { rows });
    }
  } finally {
    await session.close();
  }
}
