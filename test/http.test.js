'use strict';
// Prova completa attraverso le API, come le usa la web app.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { creaApp } = require('../src/app');
const { assicuraAmministratore } = require('../src/services/accessi');
const { nuovoDb, ist } = require('./aiuto');

let db, server, base;
const ORA = ist('2026-10-15', '10:00');
const silenzioso = { info() {}, warn() {}, error() {} };

test.before(async () => {
  db = await nuovoDb();
  await assicuraAmministratore(db, 'admin@esempio.it', 'password-admin-1');
  const config = { produzione: false, sessionSecret: 'prova', publicBaseUrl: 'https://presenze.esempio.it', entra: null, google: null };
  server = http.createServer(creaApp({ db, config, log: silenzioso, ora: () => ORA }));
  await new Promise((ok) => server.listen(0, ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await db.chiudi(); });

function client() {
  let cookie = '';
  return async function chiama(metodo, percorso, corpo, intestazioni = {}) {
    const r = await fetch(base + percorso, {
      method: metodo,
      headers: { ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...intestazioni },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
    const c = r.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    return { status: r.status, dati: await r.json() };
  };
}

test('percorso completo: anagrafica, attivazione, timbratura dimenticata, correzione', async () => {
  const admin = client();
  assert.equal((await admin('POST', '/api/auth/login', { email: 'admin@esempio.it', password: 'password-admin-1' })).status, 200);

  const prof = await admin('POST', '/api/admin/profili', { nome: 'Ufficio', regole: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((g) => [g, [{ da: '08:30', a: '17:30' }]])) });
  assert.equal(prof.status, 200);
  const p = await admin('POST', '/api/admin/persone', { nome: 'Luca', cognome: 'Verdi', email: 'luca@esempio.it' });
  assert.equal(p.status, 200);
  const id = p.dati.id;
  assert.equal((await admin('POST', `/api/admin/persone/${id}/profilo`, { profilo_id: prof.dati.id, dal: '2026-01-01' })).status, 200);
  assert.equal((await admin('POST', `/api/admin/persone/${id}/badge`, { codice: 'B-77', dal: '2026-01-01' })).status, 200);

  const att = await admin('POST', `/api/admin/persone/${id}/attivazione`, {});
  assert.match(att.dati.link, /^https:\/\/presenze\.esempio\.it\/#attiva=/);
  const token = att.dati.link.split('#attiva=')[1];

  const luca = client();
  assert.equal((await luca('GET', '/api/me')).status, 401);
  assert.equal((await luca('POST', '/api/auth/attiva', { token, password: 'password-luca-1' })).status, 200);
  const me = await luca('GET', '/api/me');
  assert.equal(me.dati.email, 'luca@esempio.it');
  assert.equal(me.dati.admin, false);
  assert.equal((await luca('GET', '/api/admin/persone')).status, 403);
  assert.equal((await luca('POST', '/api/me/timbra', {})).status, 403); // remoto non abilitato

  // il terminale registra l'entrata di ieri
  const disp = await admin('POST', '/api/admin/dispositivi', { nome: 'Ingresso' });
  const kiosk = (corpo) => fetch(`${base}/api/kiosk/timbrature`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${disp.dati.token}` }, body: JSON.stringify(corpo),
  }).then((r) => r.json());
  const k = await kiosk({ timbrature: [{ id: crypto.randomUUID(), codice: 'B-77', istante: ist('2026-10-14', '08:30') }] });
  assert.equal(k.esiti[0].esito, 'ok');
  assert.equal(k.esiti[0].verso, 'entrata');
  const senza = await fetch(`${base}/api/kiosk/ping`);
  assert.equal(senza.status, 401);

  // Luca ha dimenticato l'uscita e la inserisce da solo
  const dim = await luca('POST', '/api/me/timbrature/dimenticata', { giorno: '2026-10-14', ora: '17:30', verso: 'uscita', motivo: 'dimenticata' });
  assert.equal(dim.status, 200, JSON.stringify(dim.dati));
  const cart = await luca('GET', '/api/me/cartellino?mese=2026-10');
  const g = cart.dati.giorni.find((x) => x.giorno === '2026-10-14');
  assert.equal(g.minutiLavorati, 540);
  assert.equal(g.manuali, true);

  // l'amministrazione la vede fra le cose da controllare e la sposta
  const an = await admin('GET', '/api/admin/anomalie?dal=2026-10-14&al=2026-10-14');
  const riga = an.dati.find((x) => x.persona.id === id);
  assert.ok(riga && riga.manuali);
  const manuale = riga.timbrature.find((t) => t.origine === 'manuale');
  const corr = await admin('POST', '/api/admin/correzioni', { tipo: 'spostamento', timbratura_id: manuale.id, giorno: '2026-10-14', ora: '17:00', motivo: 'uscito alle 17' });
  assert.equal(corr.status, 200, JSON.stringify(corr.dati));
  const cart2 = await admin('GET', `/api/admin/cartellino?persona=${id}&mese=2026-10`);
  assert.equal(cart2.dati.giorni.find((x) => x.giorno === '2026-10-14').minutiLavorati, 510);
});

test('richieste non JSON e rotte sconosciute', async () => {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(r.status, 415);
  assert.equal((await fetch(`${base}/api/non-esiste`)).status, 404);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});

test('troppi login sbagliati bloccano temporaneamente', async () => {
  const c = client();
  let ultimo;
  for (let i = 0; i < 11; i++) ultimo = await c('POST', '/api/auth/login', { email: 'admin@esempio.it', password: 'sbagliata' }, { 'x-forwarded-for': '10.0.0.9' });
  assert.equal(ultimo.status, 429);
});
