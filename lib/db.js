import { Pool, types } from "pg";

// ── Fix: TIMESTAMP WITHOUT TIME ZONE (OID 1114) ───────────────────────────────
// When SET TIME ZONE is active, PostgreSQL returns TIMESTAMP values in the
// session's local time (e.g. "2024-04-16 15:14:00" for 3:14 PM PKT).
// The pg driver treats that bare string as UTC on a UTC cloud server, so the
// resulting Date is shifted +5 h and the frontend shows the wrong time.
// Fix: derive the timezone's UTC offset string from DB_TIMEZONE via Intl, then
// append it before parsing so new Date() creates the correct UTC instant.
if (process.env.DB_TIMEZONE) {
  try {
    const probe = new Date("2024-01-15T00:00:00Z");
    const tzOffsetStr =
      new Intl.DateTimeFormat("en-US", {
        timeZone: process.env.DB_TIMEZONE,
        timeZoneName: "longOffset",
      })
        .formatToParts(probe)
        .find((p) => p.type === "timeZoneName")
        ?.value?.replace("GMT", "") ?? "+00:00";

    types.setTypeParser(1114, (val) =>
      val ? new Date(val.replace(" ", "T") + tzOffsetStr) : null
    );
  } catch {
    // Intl unavailable — fall back to default pg parsing
  }
}

// Reuse the pool across hot reloads in development.
// SSL is explicitly required for Neon (and any production PostgreSQL host).
if (!global._pgPool) {
  global._pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

const pool = global._pgPool;

/**
 * Run a single SQL query.
 *
 * When DB_TIMEZONE is set, the timezone is applied to the connection before
 * every query. This is more reliable than setting it only on new connections
 * (which fails when a connection pooler such as Neon/PgBouncer resets session
 * state between transactions), guaranteeing that CURRENT_DATE and NOW() always
 * reflect the restaurant's local clock — not the UTC server clock.
 *
 * Usage in a repository:
 *   import { query } from "../lib/db";
 *   const result = await query("SELECT * FROM users WHERE id = $1", [userId]);
 *   return result.rows;
 */
export async function query(sql, params = []) {
  if (!process.env.DB_TIMEZONE) {
    return pool.query(sql, params);
  }
  const client = await pool.connect();
  try {
    await client.query(`SET TIME ZONE '${process.env.DB_TIMEZONE}'`);
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

/**
 * Run multiple queries inside a single transaction.
 * Automatically rolls back if any query throws.
 *
 * Usage:
 *   import { withTransaction } from "../lib/db";
 *   await withTransaction(async (client) => {
 *     await client.query("INSERT INTO orders ...", [...]);
 *     await client.query("INSERT INTO order_items ...", [...]);
 *   });
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    if (process.env.DB_TIMEZONE) {
      await client.query(`SET TIME ZONE '${process.env.DB_TIMEZONE}'`);
    }
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

/**
 * Quick connectivity check — used by the /api/db-test endpoint.
 * Returns true if the database is reachable, throws if not.
 */
export async function testConnection() {
  const result = await query("SELECT NOW() AS time");
  return result.rows[0].time;
}

export default pool;
