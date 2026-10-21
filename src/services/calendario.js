'use strict';
// Turni teorici di una persona su un intervallo di giorni: profili assegnati,
// festività nazionali e festività aziendali.

const { turnoDel } = require('../core/profili');
const { festivitaNazionali } = require('../core/festivita');
const { aggiungiGiorni } = require('../core/tempo');

async function caricaCalendario(q, personaId, dal, al) {
  // margine di un giorno per i turni notturni a cavallo dell'intervallo
  const da = aggiungiGiorni(dal, -1), a = aggiungiGiorni(al, 1);
  const assegnazioni = await q.query(
    `SELECT a.dal, a.al, p.regole, p.tolleranza_notte_min
       FROM assegnazione_orario a JOIN profilo_orario p ON p.id = a.profilo_id
      WHERE a.persona_id = $1 AND a.dal <= $3 AND (a.al IS NULL OR a.al >= $2)
      ORDER BY a.dal, a.id`,
    [personaId, da, a]);
  const festivita = new Map();
  for (let y = Number(da.slice(0, 4)); y <= Number(a.slice(0, 4)); y++) {
    for (const [g, n] of festivitaNazionali(y)) festivita.set(g, n);
  }
  for (const r of await q.query('SELECT data, nome FROM festivita WHERE data BETWEEN $1 AND $2', [da, a])) {
    festivita.set(r.data, r.nome);
  }
  const cache = new Map();
  function turnoPer(giorno) {
    if (cache.has(giorno)) return cache.get(giorno);
    let ass = null;
    for (const x of assegnazioni) if (x.dal <= giorno && (!x.al || x.al >= giorno)) ass = x; // vince la più recente
    const t = ass ? turnoDel({ regole: ass.regole }, giorno, festivita.has(giorno), ass.tolleranza_notte_min) : null;
    cache.set(giorno, t);
    return t;
  }
  return { turnoPer, festivita };
}

module.exports = { caricaCalendario };
