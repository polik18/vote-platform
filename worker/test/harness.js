// M2: Test harness for the vote-platform Worker.
//
// No `wrangler test` in wrangler 4.146.0, and no vitest/better-sqlite3 deps.
// We use Node v26 built-ins only:
//   - node:sqlite  (DatabaseSync) backs an in-memory D1-compatible shim
//   - node:test    runs the test files
//   - jose         mints role-scoped JWTs; a fetch interceptor serves a
//                  matching JWKS so the worker's createRemoteJWKSet verifies.
//
// Run with:  node --test test/*.test.js
//            (or: npm test)

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as jose from 'jose';
import { jwtVerify } from 'jose';

const WORKER_PATH = resolve(process.cwd(), 'src/index.js');
const MIGRATIONS = [
  readFileSync(resolve(process.cwd(), 'migrations/0001_init.sql'), 'utf8'),
  readFileSync(resolve(process.cwd(), 'migrations/0002_poll_integrity.sql'), 'utf8')
];

// --- D1-compatible shim over node:sqlite. ------------------------------------
// Faithfully reproduces the D1 binding methods the worker relies on:
//   prepare().bind(...).run()/.get()/.all()/.first()
//   prepare().run()/.get()/.all()
//   prepare().batch([{stmt, args}])
const d1Result = (r) => ({
  success: true,
  meta: {
    changes: r.changes,
    lastInsertRowid: r.lastInsertRowid,
    rowsRead: r.changes,
    rowsWritten: r.changes,
    primaryKeys: [],
    columns: []
  }
});

class D1Statement {
  constructor(stmt) {
    this._stmt = stmt;
  }
  bind(...args) {
    const self = this;
    return {
      run() { return d1Result(self._stmt.run(...args)); },
      get() { return d1Row(self._stmt.get(...args)); },
      all() { return { results: d1Rows(self._stmt.all(...args)) }; },
      first() {
        const rows = self._stmt.all(...args);
        return rows.length ? rows[0] : null;
      }
    };
  }
  run(...args) { return d1Result(this._stmt.run(...args)); }
  get(...args) { return d1Row(this._stmt.get(...args)); }
  all(...args) { return { results: d1Rows(this._stmt.all(...args)) }; }
}

function d1Row(row) {
  if (row === undefined) return null;
  return row;
}

function d1Rows(rows) {
  return Array.isArray(rows) ? rows : [];
}

class D1Shim {
  constructor(db) {
    this._db = db;
  }
  prepare(sql) {
    const stmt = this._db.prepare(sql);
    return new D1Statement(stmt);
  }
  async batch(stmts) {
    for (const s of stmts) {
      if (typeof s.run === 'function') {
        s.run();
      } else {
        this._db.prepare(s.stmt).bind(...(s.args ?? [])).run();
      }
    }
    return { count: stmts.length };
  }
}

// --- D1 fixtures -------------------------------------------------------------
function newDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  // Apply each migration directly on the raw DatabaseSync (StatementSync.bind()
  // with no args does not execute reliably here).
  for (const sql of MIGRATIONS) {
    for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch { /* conditional stmts ignored */ }
    }
  }
  return new D1Shim(db);
}

// --- JWKS interception -------------------------------------------------------
let originalFetch;
let testJwk;
let testPrivateKey;

async function setupJwks() {
  if (originalFetch) return;
  originalFetch = globalThis.fetch;
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  testPrivateKey = privateKey;
  testJwk = await jose.exportJWK(publicKey);
  testJwk.kid = 'test-key';

  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? '');
    if (url.includes('googleapis.com') && url.includes('jwk')) {
      return new Response(JSON.stringify({ keys: [testJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return originalFetch(input);
  };
}

// --- JWT minting -------------------------------------------------------------
async function makeJwt(sub, email, role = 'user', name = 'Test User', sign_in_provider = 'google.com') {
  const claims = {
    iss: 'https://securetoken.google.com/vote-28c57',
    aud: 'vote-28c57',
    sub,
    email,
    email_verified: true,
    name,
    role
  };
  if (sign_in_provider !== null) claims.sign_in_provider = sign_in_provider;
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(testPrivateKey);
}

// --- Request builder ---------------------------------------------------------
function req(path, { method = 'GET', body, token } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request('https://api.example.com' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
}

// --- Env builder -------------------------------------------------------------
function createEnv(db) {
  return {
    DB: db,
    FIREBASE_PROJECT_ID: 'vote-28c57',
    SUPER_ADMIN_EMAIL: 'jamespolik@gmail.com',
    ALLOWED_ORIGINS: 'http://localhost:5173,https://polik18.github.io'
  };
}

// --- Worker ------------------------------------------------------------------
let worker;
async function getWorker() {
  if (!worker) worker = (await import(WORKER_PATH)).default;
  return worker;
}

export {
  getWorker,
  newDb,
  setupJwks,
  makeJwt,
  req,
  createEnv,
  jwtVerify
};
