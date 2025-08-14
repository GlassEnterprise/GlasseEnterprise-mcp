import neo4j, { Driver } from "neo4j-driver";

export interface Neo4jConfig {
  uri: string;
  username: string;
  password: string;
  database?: string;
}

let driverSingleton: Driver | null = null;

/**
 * Ensure a standard Bolt port is present when missing.
 */
function ensurePort(uri: string): string {
  try {
    const u = new URL(uri);
    if (!u.port) {
      u.port = "7687";
    }
    // Remove trailing slash if URL() adds it
    return u.toString().replace(/\/$/, "");
  } catch {
    // If URL parsing fails for any reason, just return original
    return uri;
  }
}

/**
 * If NODE_TLS_REJECT_UNAUTHORIZED=0 is set (dev bypass), convert any secure scheme
 * (neo4j+s, neo4j+ssc, bolt+s, bolt+ssc) to bolt+ssc:// to accept self-signed/unknown CA.
 * This keeps encryption on (required by Aura) while skipping strict verification.
 */
function applyDevTlsBypass(uri: string): string {
  const bypass = process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0";
  let next = ensurePort(uri);
  if (bypass) {
    next = next
      .replace(/^neo4j\+s(sc)?:\/\//, "bolt+ssc://")
      .replace(/^bolt\+s(sc)?:\/\//, "bolt+ssc://")
      .replace(/^neo4j:\/\//, "bolt+ssc://");
  }
  return next;
}

/**
 * Prefer direct bolt connection over routing scheme to avoid discovery issues.
 * Also ensure TLS is used when converting from neo4j:// (Aura requires encryption).
 * - neo4j+s:// -> bolt+s://
 * - neo4j://   -> bolt+s://
 */
function preferDirectBolt(uri: string): string {
  let next = ensurePort(uri);
  if (/^neo4j\+s(sc)?:\/\//.test(next)) {
    next = next.replace(/^neo4j\+s(sc)?:\/\//, "bolt+s://");
  } else if (/^neo4j:\/\//.test(next)) {
    next = next.replace(/^neo4j:\/\//, "bolt+s://");
  }
  return next;
}

function toSecure(uri: string): string {
  return ensurePort(uri)
    .replace(/^neo4j\+s(sc)?:\/\//, "bolt+s://")
    .replace(/^neo4j:\/\//, "bolt+s://")
    .replace(/^bolt\+ssc:\/\//, "bolt+s://");
}

function toSelfSigned(uri: string): string {
  return ensurePort(uri)
    .replace(/^neo4j\+s(sc)?:\/\//, "bolt+ssc://")
    .replace(/^neo4j:\/\//, "bolt+ssc://")
    .replace(/^bolt\+s:\/\//, "bolt+ssc://");
}

function toPlain(uri: string): string {
  return ensurePort(uri)
    .replace(/^neo4j\+s(sc)?:\/\//, "bolt://")
    .replace(/^bolt\+s(sc)?:\/\//, "bolt://")
    .replace(/^neo4j:\/\//, "bolt://");
}

async function tryConnect(
  uri: string,
  auth: any,
  database?: string
): Promise<Driver> {
  const driver = neo4j.driver(uri, auth, {
    connectionTimeout: Number(process.env.NEO4J_CONNECTION_TIMEOUT_MS) || 8000,
    maxConnectionPoolSize: Number(process.env.NEO4J_MAX_POOL_SIZE) || 50,
  });
  const session = driver.session({ database: database || "neo4j" });
  try {
    await session.run(
      "RETURN 1 as ok",
      {},
      { timeout: Number(process.env.NEO4J_QUERY_TIMEOUT_MS) || 10000 }
    );
    return driver;
  } finally {
    try {
      await session.close();
    } catch {
      // ignore close errors
    }
  }
}

export async function getDriver(config: Neo4jConfig): Promise<Driver> {
  if (driverSingleton) {
    return driverSingleton;
  }

  const auth = neo4j.auth.basic(config.username, config.password);

  // Build candidate URIs considering dev TLS bypass and avoiding routing discovery
  const base = ensurePort(config.uri);
  const devBypassApplied = applyDevTlsBypass(base);
  const directPreferred = preferDirectBolt(base);

  const secure = toSecure(base);
  const ssc = toSelfSigned(base);
  const plain = toPlain(base);

  const candidates: string[] = [];
  const pushUnique = (u: string) => {
    if (u && !candidates.includes(u)) candidates.push(u);
  };

  // If dev bypass is set, try self-signed first (keeps encryption), then plain, then strict secure
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    pushUnique(devBypassApplied); // typically bolt+ssc://...
    pushUnique(ssc);
    pushUnique(plain);
    pushUnique(secure);
  } else {
    // Otherwise, try strict secure first, then self-signed, then plain
    pushUnique(directPreferred); // typically bolt+s://...
    pushUnique(secure);
    pushUnique(ssc);
    pushUnique(plain);
  }

  let lastError: any;
  for (const uri of candidates) {
    try {
      const drv = await tryConnect(uri, auth, config.database);
      driverSingleton = drv;
      return driverSingleton;
    } catch (e: any) {
      lastError = e;
      // continue to next candidate
    }
  }

  throw new Error(
    `Neo4j connection failed after trying ${candidates.join(", ")}: ${
      lastError?.message || lastError
    }`
  );
}

export async function runQuery<T = any>(
  driver: Driver,
  query: string,
  params: Record<string, any> = {},
  database?: string
): Promise<T[]> {
  const session = driver.session({ database: database || "neo4j" });
  try {
    const res = await session.run(query, params, {
      timeout: Number(process.env.NEO4J_QUERY_TIMEOUT_MS) || 30000,
    });
    return res.records.map((r) => r.toObject()) as T[];
  } finally {
    await session.close();
  }
}

export async function closeDriver(): Promise<void> {
  if (driverSingleton) {
    try {
      await driverSingleton.close();
    } catch {
      // ignore close errors
    }
    driverSingleton = null;
  }
}
