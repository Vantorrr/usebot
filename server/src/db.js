import pg from 'pg';

let pool;

export function getDb() {
  if (!pool) {
    // Use DATABASE_URL if available (Railway), otherwise individual vars
    if (process.env.DATABASE_URL) {
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 10,
        idleTimeoutMillis: 30000
      });
    } else {
      pool = new pg.Pool({
        host: process.env.POSTGRES_HOST || 'localhost',
        port: Number(process.env.POSTGRES_PORT || 5432),
        user: process.env.POSTGRES_USER || 'postgres',
        password: process.env.POSTGRES_PASSWORD || '',
        database: process.env.POSTGRES_DB || 'postgres',
        max: 10,
        idleTimeoutMillis: 30000
      });
    }
  }
  return pool;
}


