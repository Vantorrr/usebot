import pg from 'pg';

let pool;

export function getDb() {
  if (!pool) {
    pool = new pg.Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT || 5432),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      max: 10,
      idleTimeoutMillis: 30000
    });
  }
  return pool;
}


