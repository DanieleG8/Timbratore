'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { hashPassword, verificaPassword } = require('../src/auth/password');
const sessione = require('../src/auth/sessione');
const { creaVerificatore } = require('../src/auth/oidc');
const accessi = require('../src/services/accessi');
const { nuovoDb } = require('./aiuto');

test('password: hash e verifica', async () => {
  const h = await hashPassword('una password lunga');
  assert.match(h, /^scrypt\$/);
  assert.equal(await verificaPassword('una password lunga', h), true);
  assert.equal(await verificaPassword('sbagliata', h), false);
  assert.equal(await verificaPassword('x', 'robaccia'), false);
});

test('sessione: firmata, manomissione e scadenza respinte', () => {
  const v = sessione.creaValore(7, 1, 'segreto', 1000);
  assert.deepEqual(sessione.leggiValore(v, 'segreto', 2000).p, 7);
  assert.equal(sessione.leggiValore(v, 'altro-segreto', 2000), null);
  const [dati, firma] = v.split('.');
  const falso = Buffer.from(JSON.stringify({ p: 1, v: 1, e: 1e15 })).toString('base64url');
  assert.equal(sessione.leggiValore(`${falso}.${firma}`, 'segreto'), null);
  assert.equal(sessione.leggiValore(`${dati}.${firma}`, 'segreto', 1000 + 31 * 86400000), null);
});

// Provider finto: chiavi RSA generate qui, JWKS servito da una fetch finta.
function providerFinto() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const fetchFn = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  const firma = (payload, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) => {
    const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const dati = `${b(header)}.${b(payload)}`;
    return `${dati}.${crypto.sign('RSA-SHA256', Buffer.from(dati), privateKey).toString('base64url')}`;
  };
  return { fetchFn, firma };
}

test('token Microsoft: tenant, destinatario, scadenza', async () => {
  const { fetchFn, firma } = providerFinto();
  const entra = { tenant: 'tenant-1', clientId: 'app-1' };
  const v = creaVerificatore({ entra, fetchFn });
  const ora = Math.floor(Date.now() / 1000);
  const base = { aud: 'app-1', tid: 'tenant-1', iss: 'https://login.microsoftonline.com/tenant-1/v2.0', oid: 'oid-1', preferred_username: 'mario@azienda.it', exp: ora + 600 };
  assert.deepEqual(await v.microsoft(firma(base)), { idEsterno: 'oid-1', email: 'mario@azienda.it', nome: null });
  await assert.rejects(v.microsoft(firma({ ...base, tid: 'altro' })), /tenant/);
  await assert.rejects(v.microsoft(firma({ ...base, aud: 'altra-app' })), /destinatario/);
  await assert.rejects(v.microsoft(firma({ ...base, exp: ora - 3600 })), /scaduto/);
  await assert.rejects(v.microsoft(firma(base, { alg: 'none', kid: 'k1' })), /algoritmo/);
  const altro = providerFinto();
  await assert.rejects(v.microsoft(altro.firma(base)), /firma/);
});

test('token Google: solo dominio Workspace aziendale', async () => {
  const { fetchFn, firma } = providerFinto();
  const v = creaVerificatore({ google: { clientId: 'g-1', hd: 'azienda.it' }, fetchFn });
  const ora = Math.floor(Date.now() / 1000);
  const base = { aud: 'g-1', iss: 'https://accounts.google.com', sub: 's-1', email: 'anna@azienda.it', email_verified: true, hd: 'azienda.it', exp: ora + 600 };
  assert.equal((await v.google(firma(base))).idEsterno, 's-1');
  await assert.rejects(v.google(firma({ ...base, hd: undefined })), /dominio/);
  await assert.rejects(v.google(firma({ ...base, hd: 'altro.it' })), /dominio/);
  await assert.rejects(v.google(firma({ ...base, email_verified: false })), /verificata/);
});

test('login esterno: collegamento per email al primo accesso, poi per id', async () => {
  const db = await nuovoDb();
  const [p] = await db.query("INSERT INTO persona (nome, cognome, email) VALUES ('Mario', 'Rossi', 'Mario@Azienda.it') RETURNING id");
  assert.equal(await accessi.loginEsterno(db, 'microsoft', { idEsterno: 'oid-1', email: 'mario@azienda.it' }), p.id);
  // poi conta l'id, anche se l'email cambia
  assert.equal(await accessi.loginEsterno(db, 'microsoft', { idEsterno: 'oid-1', email: 'nuova@azienda.it' }), p.id);
  // stessa email ma account diverso: serve l'amministrazione
  await assert.rejects(accessi.loginEsterno(db, 'microsoft', { idEsterno: 'oid-2', email: 'mario@azienda.it' }), /Account diverso/);
  await assert.rejects(accessi.loginEsterno(db, 'google', { idEsterno: 's-9', email: 'sconosciuto@azienda.it' }), /non è abilitato/);
  await db.query('UPDATE persona SET attiva = false WHERE id = $1', [p.id]);
  await assert.rejects(accessi.loginEsterno(db, 'microsoft', { idEsterno: 'oid-1', email: 'mario@azienda.it' }), /non è abilitato/);
  await db.chiudi();
});

test('credenziali locali: attivazione una volta sola, poi login', async () => {
  const db = await nuovoDb();
  const [p] = await db.query("INSERT INTO persona (nome, cognome, email) VALUES ('Anna', 'Bianchi', 'anna@esempio.it') RETURNING id");
  await assert.rejects(accessi.loginLocale(db, 'anna@esempio.it', 'qualcosa di lungo'), /Credenziali/);
  const token = await accessi.creaAttivazione(db, p.id);
  await assert.rejects(accessi.attiva(db, token, 'corta'), /10 caratteri/);
  await accessi.attiva(db, token, 'password-nuova-1');
  await assert.rejects(accessi.attiva(db, token, 'password-nuova-2'), /scaduto o già usato/);
  assert.equal(await accessi.loginLocale(db, 'ANNA@esempio.it', 'password-nuova-1'), p.id);
  await assert.rejects(accessi.loginLocale(db, 'anna@esempio.it', 'password-sbagliata'), /Credenziali/);
  await db.chiudi();
});

test('primo amministratore creato una volta sola', async () => {
  const db = await nuovoDb();
  const id = await accessi.assicuraAmministratore(db, 'capo@esempio.it', 'password-capo-1');
  assert.ok(id);
  assert.equal(await accessi.assicuraAmministratore(db, 'altro@esempio.it', 'password-altro'), null);
  assert.equal(await accessi.loginLocale(db, 'capo@esempio.it', 'password-capo-1'), id);
  await db.chiudi();
});
