// Applies the SQL files in supabase/migrations to the Supabase database, in
// name order, each exactly once. Railway runs this before every deploy
// (railway.json → deploy.preDeployCommand), so the schema is always current.
//
//   DATABASE_URL=postgresql://... node src/migrate.js
//
// Use Supabase's *session pooler* connection string (port 5432): Railway has no
// IPv6, which the direct db.<ref>.supabase.co address needs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCK_ID = 727_318_001; // any constant; stops two deploys migrating at once
const PASSWORD_PLACEHOLDER = '[YOUR-PASSWORD]';

// The Docker image keeps migrations in /app/migrations; in the repo they live
// in /supabase/migrations.
export function findMigrationsDir(env = process.env) {
  const candidates = [env.MIGRATIONS_DIR, path.resolve(here, '../migrations'), path.resolve(here, '../../supabase/migrations')];
  const dir = candidates.find((d) => d && fs.existsSync(d));
  if (!dir) throw new Error(`No migrations folder found (looked in: ${candidates.filter(Boolean).join(', ')})`);
  return dir;
}

// Accepts the URL exactly as Supabase shows it, with "[YOUR-PASSWORD]" left in,
// when the password is given separately in DATABASE_PASSWORD.
export function resolveDatabaseUrl(env = process.env) {
  const url = env.DATABASE_URL?.trim();
  if (!url) return null;
  if (url.includes(PASSWORD_PLACEHOLDER)) {
    if (!env.DATABASE_PASSWORD) throw new Error('DATABASE_URL contains [YOUR-PASSWORD]; set DATABASE_PASSWORD too');
    return url.replace(PASSWORD_PLACEHOLDER, encodeURIComponent(env.DATABASE_PASSWORD));
  }
  return url;
}

// node-postgres lets sslmode in the URL override the ssl option, and treats
// sslmode=require as full verification, which fails against Supabase's own CA.
// So sslmode is removed from the URL and SSL is configured here instead:
// always encrypted, verified only when DATABASE_CA_CERT (Supabase's CA) is set.
export function connectionConfig(connectionString, env = process.env) {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  let ssl;
  if (sslmode === 'disable' || (local && !sslmode)) ssl = false;
  else if (env.DATABASE_CA_CERT) ssl = { ca: env.DATABASE_CA_CERT.replace(/\\n/g, '\n') };
  else ssl = { rejectUnauthorized: false };
  return { connectionString: url.toString(), ssl, application_name: 'job-autopilot-migrate', connectionTimeoutMillis: 20_000 };
}

export async function migrate({ connectionString, dir = findMigrationsDir(), log = console.log, env = process.env }) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = new pg.Client(connectionConfig(connectionString, env));
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
    // Kept out of the public schema so Supabase's REST API never exposes it.
    await client.query(`
      create schema if not exists app_private;
      create table if not exists app_private.schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      );
    `);
    const { rows } = await client.query('select name from app_private.schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    const applied = [];
    for (const file of files) {
      if (done.has(file)) continue;
      log(`Applying ${file}…`);
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into app_private.schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw new Error(`${file} failed: ${error.message}`, { cause: error });
      }
      applied.push(file);
    }
    log(applied.length ? `Applied ${applied.length} migration(s): ${applied.join(', ')}` : 'Database is up to date.');
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

// CLI entry point (Railway pre-deploy command / `npm run migrate`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let connectionString;
  try {
    connectionString = resolveDatabaseUrl();
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    process.exit(1);
  }
  if (!connectionString) {
    console.log('DATABASE_URL is not set, so database migrations were skipped. Run supabase/migrations/*.sql in the Supabase SQL editor instead.');
    process.exit(0);
  }
  migrate({ connectionString }).then(
    () => process.exit(0),
    (error) => {
      console.error(`Migration failed: ${error.message}`);
      process.exit(1);
    },
  );
}
