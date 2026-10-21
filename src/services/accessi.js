'use strict';
// Login (locale, Microsoft, Google), attivazione delle credenziali locali e
// primo amministratore. Non c'è registrazione libera: entra solo chi è in
// anagrafica e attivo.

const crypto = require('crypto');
const { hashPassword, verificaPassword, problemaPassword } = require('../auth/password');
const { richiesta, ErroreApi } = require('../errori');

const negato = () => new ErroreApi(401, 'Credenziali non valide');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Hash fittizio per impiegare lo stesso tempo quando l'utente non esiste.
let hashFinto = null;

async function loginLocale(db, email, password) {
  if (!email || !password) throw negato();
  const r = await db.query(
    `SELECT p.id, a.hash_password FROM persona p JOIN accesso a ON a.persona_id = p.id AND a.provider = 'locale'
      WHERE lower(p.email) = lower($1) AND p.attiva`, [String(email).trim()]);
  hashFinto = hashFinto || await hashPassword(crypto.randomBytes(16).toString('hex'));
  const ok = await verificaPassword(password, r.length && r[0].hash_password ? r[0].hash_password : hashFinto);
  if (!r.length || !r[0].hash_password || !ok) throw negato();
  await db.query("UPDATE accesso SET ultimo_accesso = now() WHERE persona_id = $1 AND provider = 'locale'", [r[0].id]);
  return r[0].id;
}

/**
 * Login con account aziendale già verificato (vedi auth/oidc.js).
 * Si riconosce la persona dall'id stabile del provider; al primo accesso la
 * si collega tramite email (anagrafica attiva).
 */
async function loginEsterno(db, provider, { idEsterno, email }) {
  return db.tx(async (q) => {
    const giaCollegato = await q.query(
      `SELECT p.id FROM accesso a JOIN persona p ON p.id = a.persona_id
        WHERE a.provider = $1 AND a.id_esterno = $2 AND p.attiva`, [provider, idEsterno]);
    if (giaCollegato.length) {
      await q.query('UPDATE accesso SET ultimo_accesso = now() WHERE provider = $1 AND id_esterno = $2', [provider, idEsterno]);
      return giaCollegato[0].id;
    }
    if (!email) throw negato();
    const p = await q.query('SELECT id FROM persona WHERE lower(email) = lower($1) AND attiva', [email]);
    if (!p.length) throw new ErroreApi(403, 'Il tuo account non è abilitato: chiedi all\'amministrazione');
    const esistente = await q.query('SELECT id_esterno FROM accesso WHERE persona_id = $1 AND provider = $2', [p[0].id, provider]);
    if (esistente.length && esistente[0].id_esterno && esistente[0].id_esterno !== idEsterno) {
      // la stessa email ora appartiene a un altro account: serve un controllo umano
      throw new ErroreApi(403, 'Account diverso da quello collegato: chiedi all\'amministrazione');
    }
    await q.query(
      `INSERT INTO accesso (persona_id, provider, id_esterno, ultimo_accesso) VALUES ($1, $2, $3, now())
       ON CONFLICT (persona_id, provider) DO UPDATE SET id_esterno = EXCLUDED.id_esterno, ultimo_accesso = now()`,
      [p[0].id, provider, idEsterno]);
    return p[0].id;
  });
}

// Link di attivazione (o reimpostazione) della password locale, valido 7 giorni.
async function creaAttivazione(db, personaId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO accesso (persona_id, provider, attivazione_hash, attivazione_scade)
     VALUES ($1, 'locale', $2, now() + interval '7 days')
     ON CONFLICT (persona_id, provider) DO UPDATE SET attivazione_hash = EXCLUDED.attivazione_hash,
       attivazione_scade = EXCLUDED.attivazione_scade`,
    [personaId, sha256(token)]);
  return token;
}

async function attiva(db, token, password) {
  const problema = problemaPassword(password);
  if (problema) throw richiesta(problema);
  const hash = await hashPassword(password);
  return db.tx(async (q) => {
    const r = await q.query(
      `UPDATE accesso SET hash_password = $2, attivazione_hash = NULL, attivazione_scade = NULL
        WHERE attivazione_hash = $1 AND attivazione_scade > now() RETURNING persona_id`,
      [sha256(String(token || '')), hash]);
    if (!r.length) throw richiesta('Link scaduto o già usato: chiedine uno nuovo all\'amministrazione');
    // chiude le sessioni aperte con la vecchia password
    await q.query('UPDATE persona SET sessione_versione = sessione_versione + 1 WHERE id = $1', [r[0].persona_id]);
    return r[0].persona_id;
  });
}

// Primo avvio: se non c'è nessun amministratore, lo crea da ADMIN_EMAIL.
async function assicuraAmministratore(db, email, password) {
  if (!email) return null;
  const c = await db.query("SELECT count(*)::int AS n FROM persona WHERE 'admin' = ANY(ruoli)");
  if (c[0].n > 0) return null;
  const id = await db.tx(async (q) => {
    const esiste = await q.query('SELECT id FROM persona WHERE lower(email) = lower($1)', [email]);
    if (esiste.length) {
      await q.query("UPDATE persona SET ruoli = array(SELECT DISTINCT unnest(ruoli || '{admin}')), attiva = true WHERE id = $1", [esiste[0].id]);
      return esiste[0].id;
    }
    const r = await q.query(
      "INSERT INTO persona (nome, cognome, email, ruoli) VALUES ('Amministratore', '', $1, '{dipendente,admin}') RETURNING id", [email]);
    return r[0].id;
  });
  if (password && !problemaPassword(password)) {
    await db.query(
      `INSERT INTO accesso (persona_id, provider, hash_password) VALUES ($1, 'locale', $2)
       ON CONFLICT (persona_id, provider) DO UPDATE SET hash_password = EXCLUDED.hash_password`,
      [id, await hashPassword(password)]);
  }
  return id;
}

module.exports = { loginLocale, loginEsterno, creaAttivazione, attiva, assicuraAmministratore, sha256 };
