'use strict';
// Database di prova (PostgreSQL in memoria) e scorciatoie per i test.

const { apriDb, migra } = require('../src/db');
const { istanteDa } = require('../src/core/tempo');

// Tutti i giorni 08:30-12:30 e 13:30-17:30: i test non dipendono dal giorno della settimana.
const ORARIO_UFFICIO = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((g) => [String(g), [{ da: '08:30', a: '12:30' }, { da: '13:30', a: '17:30' }]]));
const NOTTURNO = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((g) => [String(g), [{ da: '22:00', a: '06:00' }]]));

async function nuovoDb() {
  const db = await apriDb('');
  await migra(db);
  return db;
}

let contatore = 0;
async function nuovaPersona(db, { regole = ORARIO_UFFICIO, dal = '2026-01-01', ruoli = ['dipendente'], remoto = false, badge } = {}) {
  contatore++;
  const p = (await db.query(
    'INSERT INTO persona (nome, cognome, email, ruoli, remoto_abilitato) VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, cognome, ruoli',
    [`Nome${contatore}`, `Cognome${contatore}`, `p${contatore}@esempio.it`, ruoli, remoto]))[0];
  if (regole) {
    const prof = (await db.query('INSERT INTO profilo_orario (nome, regole) VALUES ($1, $2) RETURNING id', [`profilo${contatore}`, JSON.stringify(regole)]))[0];
    await db.query('INSERT INTO assegnazione_orario (persona_id, profilo_id, dal) VALUES ($1, $2, $3)', [p.id, prof.id, dal]);
  }
  if (badge) await db.query('INSERT INTO badge (codice, persona_id, valido_dal) VALUES ($1, $2, $3)', [badge, p.id, dal]);
  return p;
}

const ist = (giorno, ora) => istanteDa(giorno, ora);

module.exports = { nuovoDb, nuovaPersona, ist, ORARIO_UFFICIO, NOTTURNO };
