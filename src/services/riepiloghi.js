'use strict';
// Viste per l'amministrazione: anomalie da sistemare e presenti in questo momento.

const { giornoDi, aggiungiGiorni } = require('../core/tempo');
const { riepilogo, interpretaGiornata } = require('../core/giornata');
const { caricaCalendario } = require('./calendario');
const T = require('./timbrature');

async function personeAttive(db) {
  return db.query('SELECT id, nome, cognome FROM persona WHERE attiva ORDER BY cognome, nome');
}

async function anomalie(db, dal, al, ora = new Date()) {
  const oggi = giornoDi(ora);
  const out = [];
  for (const p of await personeAttive(db)) {
    const cal = await caricaCalendario(db, p.id, dal, al);
    const per = await T.leggiGiornate(db, p.id, dal, al, cal);
    for (let g = dal; g <= al; g = aggiungiGiorni(g, 1)) {
      // la giornata di oggi è ancora in corso: aperta non vuol dire anomala
      if (g >= oggi) break;
      const r = riepilogo(g, per.get(g) || [], cal.turnoPer(g), { passato: true });
      if (r.anomalie.length || r.manuali) out.push({ persona: p, ...r });
    }
  }
  return out;
}

async function presenti(db, ora = new Date()) {
  const oggi = giornoDi(ora), ieri = aggiungiGiorni(oggi, -1);
  const out = [];
  for (const p of await personeAttive(db)) {
    const cal = await caricaCalendario(db, p.id, ieri, oggi);
    const per = await T.leggiGiornate(db, p.id, ieri, oggi, cal);
    for (const g of [oggi, ieri]) {
      const r = interpretaGiornata(per.get(g) || []);
      if (r.aperta) { out.push({ persona: p, dal: r.ultimaEntrata.istante, giorno: g }); break; }
    }
  }
  return out;
}

module.exports = { anomalie, presenti };
