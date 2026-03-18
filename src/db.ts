import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';

const { Pool } = pg;

let pool: pg.Pool;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Optimize connection pool for performance
      max: 10,                    // Max connections in pool
      min: 2,                     // Min connections to keep open
      idleTimeoutMillis: 30000,   // Close idle connections after 30s
      connectionTimeoutMillis: 5000, // Fail fast if can't connect in 5s
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function initDb(): Promise<void> {
  const client = await getPool().connect();
  try {
    // Create migrations table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Get applied migrations
    const { rows: appliedMigrations } = await client.query<{ name: string }>(
      'SELECT name FROM migrations ORDER BY id'
    );
    const appliedSet = new Set(appliedMigrations.map((m) => m.name));

    // Find migration files
    const migrationsDir = path.join(import.meta.dirname, '../migrations');
    let migrationFiles: string[] = [];

    try {
      const files = await fs.readdir(migrationsDir);
      migrationFiles = files
        .filter((f) => f.endsWith('.sql'))
        .sort();
    } catch {
      // Migrations directory might not exist in dist, try from project root
      const rootMigrationsDir = path.join(process.cwd(), 'migrations');
      const files = await fs.readdir(rootMigrationsDir);
      migrationFiles = files
        .filter((f) => f.endsWith('.sql'))
        .sort();
    }

    // Apply pending migrations
    for (const file of migrationFiles) {
      if (appliedSet.has(file)) {
        continue;
      }

      logger.info(`Applying migration: ${file}`);

      let migrationPath = path.join(import.meta.dirname, '../migrations', file);
      try {
        await fs.access(migrationPath);
      } catch {
        migrationPath = path.join(process.cwd(), 'migrations', file);
      }

      const sql = await fs.readFile(migrationPath, 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info(`Migration applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}
