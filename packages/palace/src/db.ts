import pg from "pg";

let _pool: pg.Pool | null = null;

export function createPool(connectionString?: string): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: connectionString ?? process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    // Without this handler, an 'error' event on an idle client (kernel TCP
    // timeout, PG idle_in_transaction_session_timeout, DB restart, network
    // blip) propagates as an unhandled exception and kills the worker
    // process. See #34. The pool itself recovers — the bad client is
    // discarded automatically and the next query acquires a fresh one.
    _pool.on("error", (err) => {
      console.warn(`[nexaas] pg pool client error (non-fatal, pool will reconnect): ${err.message}`);
    });
  }
  return _pool;
}

export function getPool(): pg.Pool {
  if (!_pool) {
    return createPool();
  }
  return _pool;
}

export async function sql<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const pool = getPool();
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function sqlOne<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await sql<T>(text, params);
  return rows[0] ?? null;
}

export async function sqlInTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
