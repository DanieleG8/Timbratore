'use strict';
// Decide se e a che ora chiudere automaticamente una giornata rimasta aperta.
// Funzione pura: il servizio la chiama e scrive il risultato.

const { istanteDa, aggiungiGiorni } = require('./tempo');
const { interpreta } = require('./giornata');

/**
 * @returns null se non va chiusa (ancora), altrimenti { istante, zeroOre, motivo }
 */
function decidiChiusura({ giorno, timbrature, turno, ora }) {
  const r = interpreta(timbrature);
  if (!r.aperta) return null;

  // Si chiude dopo la mezzanotte; un turno che la attraversa si aspetta fino
  // alla sua fine più la tolleranza.
  let scadenza = istanteDa(aggiungiGiorni(giorno, 1), '00:00');
  if (turno && turno.attraversaMezzanotte) {
    scadenza = new Date(turno.fine.getTime() + turno.tolleranzaMin * 60000);
  }
  if (new Date(ora) < scadenza) return null;

  const entrata = new Date(r.ultimaEntrata.istante);
  if (!turno) {
    return { istante: entrata, zeroOre: true, motivo: 'Chiusura automatica: nessun turno previsto, 0 ore conteggiate' };
  }
  if (turno.fine <= entrata) {
    return { istante: entrata, zeroOre: true, motivo: 'Chiusura automatica: entrata dopo la fine del turno, 0 ore conteggiate' };
  }
  return { istante: turno.fine, zeroOre: false, motivo: 'Chiusura automatica a fine turno' };
}

module.exports = { decidiChiusura };
