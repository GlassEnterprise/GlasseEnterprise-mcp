import { Driver } from "neo4j-driver";
import { Logger } from "../utils/logger.js";

const logger = new Logger("ResetCommand");

/**
 * Reset the Neo4j database by deleting all nodes and relationships
 */
export async function runReset(
  driver: Driver
): Promise<string> {
  const session = driver.session();
  
  try {
    // First, get counts before deletion
    const countResult = await session.run(`
      MATCH (n)
      WITH count(n) as nodeCount
      MATCH ()-[r]->()
      RETURN nodeCount, count(r) as relationshipCount
    `);
    
    const nodeCount = countResult.records[0]?.get('nodeCount')?.toNumber() || 0;
    const relationshipCount = countResult.records[0]?.get('relationshipCount')?.toNumber() || 0;
    
    if (nodeCount === 0 && relationshipCount === 0) {
      return "Database is already empty. Nothing to reset.";
    }
    
    // Delete all relationships first, then nodes
    logger.info(`Resetting database: ${nodeCount} nodes, ${relationshipCount} relationships`);
    
    // Delete all relationships
    await session.run(`
      MATCH ()-[r]->()
      DELETE r
    `);
    
    // Delete all nodes
    await session.run(`
      MATCH (n)
      DELETE n
    `);
    
    // Verify deletion
    const verifyResult = await session.run(`
      MATCH (n)
      RETURN count(n) as remaining
    `);
    
    const remaining = verifyResult.records[0]?.get('remaining')?.toNumber() || 0;
    
    if (remaining === 0) {
      logger.info("Database reset successful");
      return `✅ Database reset complete!\n` +
             `Deleted: ${nodeCount} nodes and ${relationshipCount} relationships\n` +
             `Database is now empty and ready for a fresh scan.`;
    } else {
      logger.warn(`Reset incomplete: ${remaining} nodes remaining`);
      return `⚠️ Database reset partially complete.\n` +
             `Deleted most data but ${remaining} nodes remain.\n` +
             `You may need to manually clear the database.`;
    }
    
  } catch (error) {
    logger.error("Failed to reset database", error);
    throw new Error(
      `Failed to reset database: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    await session.close();
  }
}

/**
 * Alternative: Reset only specific repository data
 */
export async function runResetRepository(
  driver: Driver,
  repoRoot: string
): Promise<string> {
  const session = driver.session();
  
  try {
    // Delete all nodes and relationships for a specific repository
    const result = await session.run(`
      MATCH (n)
      WHERE n.repoRoot = $repoRoot
      DETACH DELETE n
      RETURN count(n) as deletedCount
    `, { repoRoot });
    
    const deletedCount = result.records[0]?.get('deletedCount')?.toNumber() || 0;
    
    return `Reset repository: ${repoRoot}\n` +
           `Deleted ${deletedCount} nodes and their relationships.`;
           
  } catch (error) {
    logger.error(`Failed to reset repository ${repoRoot}`, error);
    throw new Error(
      `Failed to reset repository: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    await session.close();
  }
}
