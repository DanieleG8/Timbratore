'use strict';
// Chiusura automatica delle giornate rimaste aperte (requisiti §4.4.2).
// Gira a intervalli regolari e all'avvio: lavora sugli ultimi giorni, così
// recupera da solo una notte saltata o un riavvio di Railway. La tabella
// chiusura_automatica garantisce una sola chiusura per persona e giornata.

const crypto = require('crypto');
const { giornoDi, aggiungiGiorni, istanteDa } = require('../core/tempo');
const { decidiChiusura } = require('../core/chiusura');
const { effettive } = require('../core/giornata');
const { caricaCalendario } = require('./calendario');
const T = require('./timbrature');

async function eseguiChiusure(db, ora = new Date(), giorniIndietro = 7) {
  const oggi = giornoDi(ora);
  const dal = aggiungiGiorni(oggi, -giorniIndietro);
  const al = aggiungiGiorni(oggi, -1);
  const persone = await db.query(
    'SELECT DISTINCT persona_id FROM timbratura WHERE istante >= $1 AND annullata_il IS NULL',
    [istanteDa(dal, '00:00')]);
  const chiuse = [];
  for (const { persona_id: personaId } of persone) {
    const cal = await caricaCalendario(db, personaId, dal, al);
    const fatte = new Set((await db.query(
      'SELECT giorno FROM chiusura_automatica WHERE persona_id = $1 AND giorno BETWEEN $2 AND $3',
      [personaId, dal, al])).map((r) => r.giorno));
    const per = await T.leggiGiornate(db, personaId, dal, al, cal);
    for (const [giorno, tutte] of per) {
      if (fatte.has(giorno)) continue;
      const d = decidiChiusura({ giorno, timbrature: effettive(tutte).usate, turno: cal.turnoPer(giorno), ora });
      if (!d) continue;
      if (await T.meseChiuso(db, giorno)) continue; // resta un'anomalia da sistemare a mano
      const fatto = await db.tx(async (q) => {
        const id = crypto.randomUUID();
        const ins = await q.query(
          'INSERT INTO chiusura_automatica (persona_id, giorno, timbratura_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING giorno',
          [personaId, giorno, id]);
        if (!ins.length) return false;
        await T.inserisci(q, {
          id, persona_id: personaId, istante: d.istante, verso_dichiarato: 'uscita',
          origine: 'automatica', da_confermare: true, nota: d.motivo,
        });
        await T.registraCorrezione(q, {
          tipo: 'chiusura_automatica', persona_id: personaId, nuova_timbratura_id: id,
          dopo: { istante: d.istante, verso: 'uscita' }, motivo: d.motivo, autore_tipo: 'sistema',
        });
        return true;
      });
      if (fatto) chiuse.push({ persona_id: personaId, giorno, istante: d.istante, zeroOre: d.zeroOre });
    }
  }
  return chiuse;
}

function avviaChiusure(db, { intervalloMin = 5, log = console } = {}) {
  let inCorso = false;
  const giro = async () => {
    if (inCorso) return;
    inCorso = true;
    try {
      const chiuse = await eseguiChiusure(db);
      if (chiuse.length) log.info(`[chiusura] ${chiuse.length} giornate chiuse automaticamente`);
    } catch (e) {
      log.error('[chiusura] errore:', e);
    } finally {
      inCorso = false;
    }
  };
  giro();
  const timer = setInterval(giro, intervalloMin * 60000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { eseguiChiusure, avviaChiusure };
