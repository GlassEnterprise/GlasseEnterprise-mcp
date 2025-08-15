import { Driver } from "neo4j-driver";
import { Relationship, RelationshipType } from "../scanner/types.js";

function groupByType(
  rels: Relationship[]
): Map<RelationshipType, Relationship[]> {
  const map = new Map<RelationshipType, Relationship[]>();
  for (const r of rels) {
    const arr = map.get(r.type) ?? [];
    arr.push(r);
    map.set(r.type, arr);
  }
  return map;
}

export async function upsertRelationshipsBatch(
  driver: Driver,
  relationships: Relationship[],
  snapshotVersion?: string
): Promise<void> {
  if (!relationships.length) return;

  const byType = groupByType(relationships);
  const session = driver.session();
  try {
    for (const [type, rels] of byType.entries()) {
      // Versioned relationships: one relationship per (fromId,type,toId,snapshotVersion)
      const query = `
        UNWIND $rows AS row
        MATCH (a {id: row.fromId})
        MATCH (b {id: row.toId})
        MERGE (a)-[r:${type} {relKey: row.relKey, snapshotVersion: row.snapshotVersion}]->(b)
        ON CREATE SET r.createdAt = timestamp()
        SET r.updatedAt = timestamp()
        WITH r, row
        CALL {
          WITH r, row
          UNWIND keys(row.properties) AS k
          WITH r, k, row
          SET r[k] = row.properties[k]
          RETURN count(*) AS _
        }
        RETURN count(r) as count
      `;
      const rows = rels.map((r) => ({
        fromId: r.fromId,
        toId: r.toId,
        relKey: `${r.fromId}|${type}|${r.toId}`,
        snapshotVersion: snapshotVersion ?? null,
        properties: r.properties ?? {},
      }));
      await session.run(query, { rows });
    }
  } finally {
    await session.close();
  }
}
