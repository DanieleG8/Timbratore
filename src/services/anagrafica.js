'use strict';
// Anagrafica e configurazione gestite dall'amministrazione.

const crypto = require('crypto');
const { validaRegole } = require('../core/profili');
const { aggiungiGiorni, giornoValido, giornoDi, RE_MESE } = require('../core/tempo');
const { sha256 } = require('./accessi');
const { richiesta, nonTrovato, conflitto } = require('../errori');

const RUOLI = ['dipendente', 'responsabile', 'hr', 'admin'];

function testo(v, campo, { obbligatorio = true, max = 120 } = {}) {
  const s = String(v ?? '').trim();
  if (obbligatorio && !s) throw richiesta(`Manca ${campo}`);
  if (s.length > max) throw richiesta(`${campo}: troppo lungo`);
  return s || null;
}

function emailValida(v) {
  const s = testo(v, 'email', { obbligatorio: false, max: 200 });
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw richiesta('Email non valida');
  return s;
}

function ruoliValidi(v) {
  const r = Array.isArray(v) ? [...new Set(v)] : ['dipendente'];
  if (!r.length || r.some((x) => !RUOLI.includes(x))) throw richiesta(`Ruoli ammessi: ${RUOLI.join(', ')}`);
  return r;
}

function oggi() { return giornoDi(new Date()); }

function erroreUnico(e, messaggio) {
  if (e && e.code === '23505') throw conflitto(messaggio);
  throw e;
}

async function elencoPersone(db) {
  const persone = await db.query(
    `SELECT id, nome, cognome, email, attiva, responsabile_id, ruoli, remoto_abilitato FROM persona ORDER BY cognome, nome`);
  const g = oggi(); // data italiana: il database ragiona in UTC
  const badge = await db.query('SELECT id, codice, persona_id, valido_dal FROM badge WHERE valido_al IS NULL OR valido_al >= $1', [g]);
  const accessi = await db.query('SELECT persona_id, provider, (hash_password IS NOT NULL) AS password_impostata, ultimo_accesso FROM accesso');
  const profili = await db.query(
    `SELECT DISTINCT ON (a.persona_id) a.persona_id, p.id, p.nome FROM assegnazione_orario a
       JOIN profilo_orario p ON p.id = a.profilo_id
      WHERE a.dal <= $1 AND (a.al IS NULL OR a.al >= $1)
      ORDER BY a.persona_id, a.dal DESC, a.id DESC`, [g]);
  return persone.map((p) => ({
    ...p,
    badge: badge.filter((b) => b.persona_id === p.id),
    accessi: accessi.filter((a) => a.persona_id === p.id).map(({ persona_id, ...a }) => a),
    profilo: profili.find((x) => x.persona_id === p.id) || null,
  }));
}

async function creaPersona(db, body) {
  try {
    const r = await db.query(
      `INSERT INTO persona (nome, cognome, email, ruoli, remoto_abilitato, responsabile_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [testo(body.nome, 'nome'), testo(body.cognome, 'cognome'), emailValida(body.email),
        ruoliValidi(body.ruoli), !!body.remoto_abilitato, body.responsabile_id || null]);
    return r[0];
  } catch (e) { return erroreUnico(e, 'Email già usata da un\'altra persona'); }
}

async function aggiornaPersona(db, id, body) {
  const attuale = (await db.query('SELECT * FROM persona WHERE id = $1', [id]))[0];
  if (!attuale) throw nonTrovato('Persona non trovata');
  const nuovo = {
    nome: body.nome !== undefined ? testo(body.nome, 'nome') : attuale.nome,
    cognome: body.cognome !== undefined ? testo(body.cognome, 'cognome') : attuale.cognome,
    email: body.email !== undefined ? emailValida(body.email) : attuale.email,
    ruoli: body.ruoli !== undefined ? ruoliValidi(body.ruoli) : attuale.ruoli,
    remoto: body.remoto_abilitato !== undefined ? !!body.remoto_abilitato : attuale.remoto_abilitato,
    attiva: body.attiva !== undefined ? !!body.attiva : attuale.attiva,
    responsabile: body.responsabile_id !== undefined ? (body.responsabile_id || null) : attuale.responsabile_id,
  };
  if (nuovo.responsabile === id) throw richiesta('Una persona non può essere responsabile di sé stessa');
  try {
    await db.query(
      `UPDATE persona SET nome = $2, cognome = $3, email = $4, ruoli = $5, remoto_abilitato = $6, attiva = $7,
         responsabile_id = $8,
         sessione_versione = sessione_versione + CASE WHEN $7 = false OR $5::text[] IS DISTINCT FROM ruoli THEN 1 ELSE 0 END
       WHERE id = $1`,
      [id, nuovo.nome, nuovo.cognome, nuovo.email, nuovo.ruoli, nuovo.remoto, nuovo.attiva, nuovo.responsabile]);
  } catch (e) { erroreUnico(e, 'Email già usata da un\'altra persona'); }
  return { id };
}

// Un solo badge attivo per persona: il nuovo sostituisce il precedente.
async function assegnaBadge(db, personaId, body) {
  const codice = testo(body.codice, 'codice badge', { max: 64 });
  const dal = body.dal === undefined ? oggi() : body.dal;
  if (!giornoValido(dal)) throw richiesta('Data di inizio non valida');
  return db.tx(async (q) => {
    const p = await q.query('SELECT id FROM persona WHERE id = $1', [personaId]);
    if (!p.length) throw nonTrovato('Persona non trovata');
    const altro = await q.query('SELECT persona_id FROM badge WHERE codice = $1 AND valido_al IS NULL', [codice]);
    if (altro.length && altro[0].persona_id !== personaId) throw conflitto('Questo badge è già assegnato a un\'altra persona');
    if (altro.length) return { codice };
    await q.query('UPDATE badge SET valido_al = $2 WHERE persona_id = $1 AND valido_al IS NULL', [personaId, aggiungiGiorni(dal, -1)]);
    await q.query('INSERT INTO badge (codice, persona_id, valido_dal) VALUES ($1, $2, $3)', [codice, personaId, dal]);
    return { codice };
  });
}

async function revocaBadge(db, badgeId) {
  const r = await db.query('UPDATE badge SET valido_al = $2 WHERE id = $1 AND valido_al IS NULL RETURNING id', [badgeId, aggiungiGiorni(oggi(), -1)]);
  if (!r.length) throw nonTrovato('Badge non trovato o già revocato');
  return r[0];
}

async function elencoProfili(db) {
  return db.query('SELECT id, nome, regole, tolleranza_notte_min FROM profilo_orario ORDER BY nome');
}

async function salvaProfilo(db, id, body) {
  const nome = testo(body.nome, 'nome');
  const problema = validaRegole(body.regole);
  if (problema) throw richiesta(problema);
  const toll = body.tolleranza_notte_min === undefined ? 120 : Number(body.tolleranza_notte_min);
  if (!Number.isInteger(toll) || toll < 0 || toll > 720) throw richiesta('Tolleranza non valida (0-720 minuti)');
  try {
    if (id) {
      const r = await db.query('UPDATE profilo_orario SET nome = $2, regole = $3, tolleranza_notte_min = $4 WHERE id = $1 RETURNING id',
        [id, nome, JSON.stringify(body.regole), toll]);
      if (!r.length) throw nonTrovato('Profilo non trovato');
      return r[0];
    }
    const r = await db.query('INSERT INTO profilo_orario (nome, regole, tolleranza_notte_min) VALUES ($1, $2, $3) RETURNING id',
      [nome, JSON.stringify(body.regole), toll]);
    return r[0];
  } catch (e) { return erroreUnico(e, 'Esiste già un profilo con questo nome'); }
}

// Il nuovo profilo vale dal giorno indicato; quello in corso si chiude il giorno prima.
async function assegnaProfilo(db, personaId, body) {
  const dal = body.dal === undefined ? oggi() : body.dal;
  if (!giornoValido(dal)) throw richiesta('Data di inizio non valida');
  const profiloId = Number(body.profilo_id);
  return db.tx(async (q) => {
    if (!(await q.query('SELECT id FROM persona WHERE id = $1', [personaId])).length) throw nonTrovato('Persona non trovata');
    if (!(await q.query('SELECT id FROM profilo_orario WHERE id = $1', [profiloId])).length) throw nonTrovato('Profilo non trovato');
    await q.query('DELETE FROM assegnazione_orario WHERE persona_id = $1 AND dal >= $2', [personaId, dal]);
    await q.query('UPDATE assegnazione_orario SET al = $2 WHERE persona_id = $1 AND (al IS NULL OR al >= $3)',
      [personaId, aggiungiGiorni(dal, -1), dal]);
    await q.query('INSERT INTO assegnazione_orario (persona_id, profilo_id, dal) VALUES ($1, $2, $3)', [personaId, profiloId, dal]);
    return { persona_id: personaId, profilo_id: profiloId, dal };
  });
}

// Il token del terminale si vede una volta sola, alla creazione.
async function creaDispositivo(db, body) {
  const nome = testo(body.nome, 'nome');
  const token = crypto.randomBytes(32).toString('base64url');
  const r = await db.query('INSERT INTO dispositivo (nome, token_hash) VALUES ($1, $2) RETURNING id, nome', [nome, sha256(token)]);
  return { ...r[0], token };
}

async function elencoDispositivi(db) {
  return db.query('SELECT id, nome, tipo, attivo, ultimo_contatto, creato_il FROM dispositivo ORDER BY nome');
}

async function impostaDispositivo(db, id, body) {
  const r = await db.query('UPDATE dispositivo SET attivo = $2 WHERE id = $1 RETURNING id', [id, !!body.attivo]);
  if (!r.length) throw nonTrovato('Terminale non trovato');
  return r[0];
}

async function dispositivoDaToken(db, token) {
  if (!token) return null;
  const r = await db.query('SELECT id, nome FROM dispositivo WHERE token_hash = $1 AND attivo', [sha256(token)]);
  return r[0] || null;
}

async function chiudiMese(db, mese, autoreId) {
  if (!RE_MESE.test(String(mese))) throw richiesta('Mese non valido (AAAA-MM)');
  await db.query('INSERT INTO periodo_chiuso (mese, chiuso_da) VALUES ($1, $2) ON CONFLICT DO NOTHING', [mese, autoreId]);
  return { mese, chiuso: true };
}

async function riapriMese(db, mese) {
  await db.query('DELETE FROM periodo_chiuso WHERE mese = $1', [mese]);
  return { mese, chiuso: false };
}

async function elencoFestivita(db) {
  return db.query('SELECT data, nome FROM festivita ORDER BY data');
}

async function aggiungiFestivita(db, body) {
  if (!giornoValido(body.data)) throw richiesta('Data non valida');
  const nome = testo(body.nome, 'nome');
  await db.query('INSERT INTO festivita (data, nome) VALUES ($1, $2) ON CONFLICT (data) DO UPDATE SET nome = EXCLUDED.nome', [body.data, nome]);
  return { data: body.data, nome };
}

async function rimuoviFestivita(db, data) {
  await db.query('DELETE FROM festivita WHERE data = $1', [data]);
  return { data };
}

module.exports = {
  RUOLI, elencoPersone, creaPersona, aggiornaPersona, assegnaBadge, revocaBadge,
  elencoProfili, salvaProfilo, assegnaProfilo, creaDispositivo, elencoDispositivi,
  impostaDispositivo, dispositivoDaToken, chiudiMese, riapriMese,
  elencoFestivita, aggiungiFestivita, rimuoviFestivita,
};
