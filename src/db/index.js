'use strict';
// Accesso al database con un'interfaccia minima:
//   db.query(sql, params) -> righe
//   db.exec(sql)          -> più istruzioni senza parametri
//   db.tx(async (t) => …) -> transazione; t ha query ed exec
// In produzione PostgreSQL (Railway, DATABASE_URL). Nei test e in locale senza
// DATABASE_URL: pglite, PostgreSQL vero compilato in WebAssembly.
// Le colonne `date` tornano sempre come stringa 'YYYY-MM-DD'.

const fs = require('fs');
const path = require('path');

const OID_DATE = 1082;

async function apriDb(url) {
  if (!url || url.startsWith('pglite:')) return apriPglite(url ? url.slice('pglite:'.length) : '');
  return apriPg(url);
}

async function apriPg(url) {
  const pg = require('pg');
  pg.types.setTypeParser(OID_DATE, (v) => v);
  pg.types.setTypeParser(20, (v) => Number(v)); // bigint -> number (contatori)
  const ssl = /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString: url, ssl, max: 5 });
  const conClient = (c) => ({
    query: async (sql, params) => (await c.query(sql, params)).rows,
    exec: async (sql) => { await c.query(sql); },
  });
  return {
    tipo: 'pg',
    ...conClient(pool),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(conClient(c));
        await c.query('COMMIT');
        return r;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (_) { /* connessione già persa */ }
        throw e;
      } finally {
        c.release();
      }
    },
    chiudi: () => pool.end(),
  };
}

function dateComeStringhe(res) {
  const dateCols = (res.fields || []).filter((f) => f.dataTypeID === OID_DATE).map((f) => f.name);
  if (!dateCols.length) return res.rows;
  for (const r of res.rows) {
    for (const c of dateCols) if (r[c] instanceof Date) r[c] = r[c].toISOString().slice(0, 10);
  }
  return res.rows;
}

async function apriPglite(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pgl = new PGlite(dir || undefined);
  await pgl.waitReady;
  const conClient = (c) => ({
    query: async (sql, params) => dateComeStringhe(await c.query(sql, params)),
    exec: async (sql) => { await c.exec(sql); },
  });
  return {
    tipo: 'pglite',
    ...conClient(pgl),
    tx: (fn) => pgl.transaction((t) => fn(conClient(t))),
    chiudi: () => pgl.close(),
  };
}

async function migra(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrazioni (
    nome text PRIMARY KEY, applicata_il timestamptz NOT NULL DEFAULT now())`);
  const fatte = new Set((await db.query('SELECT nome FROM schema_migrazioni')).map((r) => r.nome));
  const dir = path.join(__dirname, 'migrazioni');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (fatte.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('INSERT INTO schema_migrazioni (nome) VALUES ($1)', [f]);
    });
  }
}

module.exports = { apriDb, migra };
