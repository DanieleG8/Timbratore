'use strict';
// Lettura e scrittura delle timbrature, comune a terminale, web, timbratura
// dimenticata, correzioni e chiusura automatica.

const crypto = require('crypto');
const { istanteDa, aggiungiGiorni, giornoDi } = require('../core/tempo');
const { giornoCompetenza } = require('../core/profili');
const { interpretaGiornata, riepilogo } = require('../core/giornata');
const { caricaCalendario } = require('./calendario');
const { conflitto } = require('../errori');

const COLONNE = `id, persona_id, istante, verso_dichiarato, origine, dispositivo_id, badge,
  posizione, nota, creata_da, sostituisce_id, da_confermare, confermata_il, confermata_da,
  annullata_il, annullata_motivo, annullata_da, ricevuta_il`;

// Timbrature (comprese le annullate) raggruppate per giornata di competenza.
async function leggiGiornate(q, personaId, dal, al, cal) {
  const rows = await q.query(
    `SELECT ${COLONNE} FROM timbratura
      WHERE persona_id = $1 AND istante >= $2 AND istante < $3
      ORDER BY istante, ricevuta_il`,
    [personaId, istanteDa(dal, '00:00'), istanteDa(aggiungiGiorni(al, 2), '00:00')]);
  const per = new Map();
  for (const r of rows) {
    const g = giornoCompetenza(r.istante, cal.turnoPer);
    if (g < dal || g > al) continue;
    if (!per.has(g)) per.set(g, []);
    per.get(g).push(r);
  }
  return per;
}

async function giornata(q, personaId, giorno, cal) {
  cal = cal || await caricaCalendario(q, personaId, giorno, giorno);
  const per = await leggiGiornate(q, personaId, giorno, giorno, cal);
  return { tutte: per.get(giorno) || [], turno: cal.turnoPer(giorno), cal };
}

async function leggiTimbratura(q, id, perAggiornare = false) {
  const rows = await q.query(`SELECT ${COLONNE} FROM timbratura WHERE id = $1${perAggiornare ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0] || null;
}

async function meseChiuso(q, giorno) {
  const r = await q.query('SELECT 1 FROM periodo_chiuso WHERE mese = $1', [giorno.slice(0, 7)]);
  return r.length > 0;
}

async function verificaMeseAperto(q, giorno) {
  if (await meseChiuso(q, giorno)) {
    throw conflitto(`Il mese ${giorno.slice(0, 7)} è chiuso: per modificarlo va prima riaperto`, 'mese_chiuso');
  }
}

// Inserisce; restituisce false se l'id esisteva già (invio ripetuto dal terminale).
async function inserisci(q, t) {
  const rows = await q.query(
    `INSERT INTO timbratura (id, persona_id, istante, verso_dichiarato, origine, dispositivo_id,
       badge, posizione, nota, creata_da, sostituisce_id, da_confermare)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [t.id || crypto.randomUUID(), t.persona_id, t.istante, t.verso_dichiarato || 'auto', t.origine,
      t.dispositivo_id || null, t.badge || null, t.posizione ? JSON.stringify(t.posizione) : null,
      t.nota || null, t.creata_da || null, t.sostituisce_id || null, !!t.da_confermare]);
  return rows.length > 0;
}

async function annulla(q, id, motivo, autoreId) {
  const rows = await q.query(
    `UPDATE timbratura SET annullata_il = now(), annullata_motivo = $2, annullata_da = $3
      WHERE id = $1 AND annullata_il IS NULL RETURNING id`,
    [id, motivo, autoreId || null]);
  return rows.length > 0;
}

async function registraCorrezione(q, c) {
  await q.query(
    `INSERT INTO correzione (tipo, persona_id, timbratura_id, nuova_timbratura_id, prima, dopo, motivo, autore_id, autore_tipo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [c.tipo, c.persona_id, c.timbratura_id || null, c.nuova_timbratura_id || null,
      c.prima ? JSON.stringify(c.prima) : null, c.dopo ? JSON.stringify(c.dopo) : null,
      c.motivo, c.autore_id || null, c.autore_tipo || 'persona']);
}

/**
 * Registra una timbratura. Da chiamare dentro una transazione. Restituisce { nuova, giorno, verso } con il verso calcolato.
 */
async function registra(q, t) {
  const id = t.id || crypto.randomUUID();
  const nuova = await inserisci(q, { ...t, id });
  const salvata = nuova ? null : await leggiTimbratura(q, id);
  const personaId = salvata ? salvata.persona_id : t.persona_id;
  const istante = salvata ? salvata.istante : t.istante;
  const cal = await caricaCalendario(q, personaId, aggiungiGiorni(giornoDi(istante), -1), giornoDi(istante));
  const giorno = giornoCompetenza(istante, cal.turnoPer);
  const g = await giornata(q, personaId, giorno);
  const r = interpretaGiornata(g.tutte);
  const riga = r.righe.find((x) => x.id === id);
  return { id, nuova, giorno, verso: riga ? riga.verso : null };
}

// Cartellino mensile: una riga per giorno più i totali.
async function cartellino(q, personaId, mese, ora = new Date()) {
  const dal = mese + '-01';
  const al = aggiungiGiorni(aggiungiGiorni(dal, 32).slice(0, 7) + '-01', -1);
  const cal = await caricaCalendario(q, personaId, dal, al);
  const per = await leggiGiornate(q, personaId, dal, al, cal);
  const oggi = giornoDi(ora);
  const giorni = [];
  for (let g = dal; g <= al; g = aggiungiGiorni(g, 1)) {
    const r = riepilogo(g, per.get(g) || [], cal.turnoPer(g), { passato: g < oggi });
    // la giornata di oggi è in corso: essere ancora dentro non è un'anomalia
    if (g >= oggi) r.anomalie = r.anomalie.filter((a) => a.tipo !== 'giornata_aperta');
    r.festivita = cal.festivita.get(g) || null;
    giorni.push(r);
  }
  const totali = giorni.reduce((s, d) => ({
    minutiLavorati: s.minutiLavorati + d.minutiLavorati,
    minutiTeorici: s.minutiTeorici + d.minutiTeorici,
    anomalie: s.anomalie + d.anomalie.length,
  }), { minutiLavorati: 0, minutiTeorici: 0, anomalie: 0 });
  return { mese, chiuso: await meseChiuso(q, dal), giorni, totali };
}

module.exports = {
  leggiGiornate, giornata, leggiTimbratura, meseChiuso, verificaMeseAperto,
  inserisci, annulla, registraCorrezione, registra, cartellino,
};
