/**
 * Local end-to-end test for FelFelChat.
 *
 * Starts an ephemeral MongoDB server as a single-node replica set (the same
 * topology class as MongoDB Atlas, which Prisma's MongoDB connector requires),
 * then runs the real deployment path used on Railway:
 *
 *   prisma db push  ->  seed  ->  node server.mjs (production)
 *
 * and verifies the live HTTP surface: /api/health, /api/ready, the login page,
 * login rejection with a bad password, login with the seeded superadmin, and
 * the resulting auth cookie.
 *
 * The mongod binary is resolved with MongoBinary (the same cache
 * mongodb-memory-server uses) and started with --fork. Prisma's Rust schema
 * engine has been observed to hang against instances spawned as child
 * processes of the test runner in some sandboxed environments, so forking and
 * shutting down via the admin command is the robust path.
 *
 * Usage:  npm run test:e2e
 *
 * No repo state is touched: the data lives in a temp dir, the database listens
 * on 127.0.0.1:41017, and the server runs on port 4321 with throwaway
 * credentials.
 */
import { MongoBinary } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { spawn, execSync } from 'child_process';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PORT = 41017;
const DB_URI = `mongodb://127.0.0.1:${DB_PORT}/felfelchat?directConnection=true`;
const APP_PORT = 4321;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
  });
}

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const cookieOf = (res) =>
  (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

// Never let a connection error crash the runner before it can report diagnostics.
const safe = (p) => p.catch((e) => ({ status: 0, headers: {}, body: `CONN_ERROR: ${e.message}` }));

async function waitForPort(port, timeoutMs = 30000) {
  const net = await import('net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.default.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

console.log('>> resolving mongod binary (cached after first download)...');
const mongodPath = await MongoBinary.getPath({ version: '7.0.14' });
const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'felfel-e2e-mongo-'));

console.log('>> starting MongoDB 7.0.14 as single-node replica set rs0 on 127.0.0.1:' + DB_PORT);
execSync(
  `"${mongodPath}" --port ${DB_PORT} --dbpath "${dbPath}" --replSet rs0 ` +
    `--bind_ip 127.0.0.1 --noauth --storageEngine wiredTiger --logpath "${dbPath}/mongod.log" --fork`,
  { shell: '/bin/bash' }
);
if (!(await waitForPort(DB_PORT))) throw new Error('mongod did not start');

console.log('>> initiating replica set...');
const client = new MongoClient(`mongodb://127.0.0.1:${DB_PORT}/?directConnection=true`);
await client.connect();
await client.db('admin').command({
  replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${DB_PORT}` }] },
});
// Wait until the member reports itself as primary
for (let i = 0; i < 30; i++) {
  const hello = await client.db('admin').command({ hello: 1 });
  if (hello.isWritablePrimary) break;
  await new Promise((r) => setTimeout(r, 500));
}
await client.close();

// Hermetic environment: throwaway credentials, injected exactly like Railway
// injects the real ones. Nothing here depends on the workspace .env/.env.local.
const childEnv = {
  ...process.env,
  DATABASE_URL: DB_URI,
  JWT_SECRET: 'e2e-throwaway-jwt-secret-0123456789abcdef',
  BACKUP_SIGNING_KEY: 'e2e-throwaway-backup-key-0123456789abcdef',
  APP_ORIGIN: `http://localhost:${APP_PORT}`,
};

try {
  console.log('>> prisma db push (same command the Railway start uses)...');
  execSync('npm run db:railway', { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'inherit'] });
  check('prisma db push applies schema', true);

  console.log('>> seeding superadmin...');
  const seedOut = execSync('npm run db:seed', { cwd: ROOT, env: childEnv, encoding: 'utf8' });
  check('seed creates superadmin', /Seeded superadmin: admin/.test(seedOut));

  console.log('>> starting production server (server.mjs)...');
  const server = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...childEnv,
      PORT: String(APP_PORT),
      NODE_ENV: 'production',
      UPLOAD_DIR: '/tmp/felfel-e2e-uploads',
      BACKUP_DIR: '/tmp/felfel-e2e-backups',
      AUDIT_LOG_DIR: '/tmp/felfel-e2e-logs',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  let health = null;
  for (let i = 0; i < 60; i++) {
    try {
      health = await get(`http://127.0.0.1:${APP_PORT}/api/health`);
      if (health.status === 200) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  check('server boots & /api/health returns 200', health?.status === 200, health?.body || '');

  const ready = await safe(get(`http://127.0.0.1:${APP_PORT}/api/ready`));
  check('/api/ready reports ready (database reachable)', ready.status === 200, ready.body.slice(0, 160));

  const page = await safe(get(`http://127.0.0.1:${APP_PORT}/login`));
  check('login page serves (200 + html)', page.status === 200 && /<html/i.test(page.body));

  const bad = await safe(
    post(`http://127.0.0.1:${APP_PORT}/api/auth/login`, {
      username: 'admin',
      password: 'wrong-password',
    })
  );
  check('login rejects wrong password (401)', bad.status === 401, bad.body);

  const good = await safe(
    post(`http://127.0.0.1:${APP_PORT}/api/auth/login`, {
      username: 'admin',
      password: 'admin123',
    })
  );
  const goodOk =
    good.status === 200 &&
    (() => {
      try {
        return JSON.parse(good.body).user.isSuperAdmin === true;
      } catch {
        return false;
      }
    })();
  check('login succeeds with seeded superadmin', goodOk, good.body.slice(0, 120));

  const me = await safe(get(`http://127.0.0.1:${APP_PORT}/api/auth/me`, { Cookie: cookieOf(good) }));
  check('auth cookie works (/api/auth/me returns 200)', me.status === 200, me.body.slice(0, 120));

  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  if (health?.status !== 200) {
    console.log('--- server log tail ---\n' + serverLog.slice(-1500));
  }
} finally {
  console.log('>> shutting down ephemeral MongoDB...');
  try {
    const shutdown = new MongoClient(`mongodb://127.0.0.1:${DB_PORT}/?directConnection=true`);
    await shutdown.connect();
    await shutdown.db('admin').command({ shutdown: 1 }).catch(() => {});
    await shutdown.close();
  } catch {}
  fs.rmSync(dbPath, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n== E2E SUMMARY: ${results.length - failed.length}/${results.length} passed ==`);
process.exit(failed.length ? 1 : 0);
