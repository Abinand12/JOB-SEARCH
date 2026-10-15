import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { connectionConfig, findMigrationsDir, migrate, resolveDatabaseUrl } from '../src/migrate.js';

test('resolveDatabaseUrl fills in the Supabase password placeholder, URL-encoded', () => {
  const url = resolveDatabaseUrl({
    DATABASE_URL: 'postgresql://postgres.abc:[YOUR-PASSWORD]@aws-0-x.pooler.supabase.com:5432/postgres',
    DATABASE_PASSWORD: 'p$q?Q&7*y',
  });
  assert.equal(url, 'postgresql://postgres.abc:p%24q%3FQ%267*y@aws-0-x.pooler.supabase.com:5432/postgres');
  assert.equal(new URL(url).password, 'p%24q%3FQ%267*y');
  assert.equal(resolveDatabaseUrl({}), null);
  assert.throws(() => resolveDatabaseUrl({ DATABASE_URL: 'postgresql://u:[YOUR-PASSWORD]@h/db' }), /DATABASE_PASSWORD/);
});

test('connectionConfig always encrypts remote connections and strips sslmode', () => {
  const remote = connectionConfig('postgresql://u:p@aws-0-x.pooler.supabase.com:5432/postgres?sslmode=require', {});
  assert.deepEqual(remote.ssl, { rejectUnauthorized: false });
  assert.doesNotMatch(remote.connectionString, /sslmode/);
  assert.deepEqual(connectionConfig('postgresql://u:p@h/db', { DATABASE_CA_CERT: 'CERT\\nLINE' }).ssl, { ca: 'CERT\nLINE' });
  assert.equal(connectionConfig('postgresql://u:p@localhost:5432/db', {}).ssl, false);
  assert.equal(connectionConfig('postgresql://u:p@h/db?sslmode=disable', {}).ssl, false);
});

test('findMigrationsDir finds the repo migrations', () => {
  assert.ok(fs.existsSync(path.join(findMigrationsDir({}), '0001_init.sql')));
});

// Runs only when a throwaway Postgres is available, e.g.
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres npm test
const dbUrl = process.env.TEST_DATABASE_URL;

test('migrate applies the schema once and is safe to re-run', { skip: !dbUrl && 'TEST_DATABASE_URL not set' }, async () => {
  const admin = new pg.Client({ connectionString: dbUrl });
  await admin.connect();
  const dbName = `migrate_test_${process.pid}`;
  await admin.query(`drop database if exists ${dbName}`);
  await admin.query(`create database ${dbName}`);
  const testUrl = Object.assign(new URL(dbUrl), { pathname: `/${dbName}` }).toString();

  try {
    // Minimal stand-ins for what Supabase provides out of the box.
    const db = new pg.Client({ connectionString: testUrl });
    await db.connect();
    await db.query(`
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean);
      create publication supabase_realtime;
    `);

    const logs = [];
    const first = await migrate({ connectionString: testUrl, log: (m) => logs.push(m), env: {} });
    assert.deepEqual(first, ['0001_init.sql']);
    const second = await migrate({ connectionString: testUrl, log: (m) => logs.push(m), env: {} });
    assert.deepEqual(second, []);
    assert.equal(logs.at(-1), 'Database is up to date.');

    const tables = await db.query(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    assert.deepEqual(
      tables.rows.map((r) => r.table_name),
      ['applications', 'extension_tokens', 'llm_usage', 'profiles', 'question_answers', 'verification_alerts'],
    );
    const rls = await db.query(`select count(*)::int as n from pg_tables where schemaname = 'public' and rowsecurity`);
    assert.equal(rls.rows[0].n, 6);
    const bucket = await db.query(`select public from storage.buckets where id = 'resumes'`);
    assert.equal(bucket.rows[0].public, false);
    const pub = await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1`);
    assert.deepEqual(pub.rows.map((r) => r.tablename), ['applications', 'verification_alerts']);

    // A failing migration rolls back and is not recorded.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    fs.copyFileSync(path.join(findMigrationsDir({}), '0001_init.sql'), path.join(dir, '0001_init.sql'));
    fs.writeFileSync(path.join(dir, '0002_broken.sql'), 'create table public.half_done (id int); select nope_this_fails();');
    await assert.rejects(migrate({ connectionString: testUrl, dir, log: () => {}, env: {} }), /0002_broken\.sql failed/);
    const half = await db.query(`select to_regclass('public.half_done') as t`);
    assert.equal(half.rows[0].t, null);
    const recorded = await db.query('select name from app_private.schema_migrations order by name');
    assert.deepEqual(recorded.rows.map((r) => r.name), ['0001_init.sql']);
    await db.end();
  } finally {
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  }
});
