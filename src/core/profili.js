'use strict';
// Profili orario: le regole sono dati.
// regole = { "1": [{ "da": "08:30", "a": "12:30" }, { "da": "13:30", "a": "17:30" }], ..., "7": [] }
// Chiavi 1 = lunedì … 7 = domenica. Una fascia con "a" <= "da" finisce il giorno dopo.

const { istanteDa, aggiungiGiorni, giornoSettimana, giornoDi, RE_ORA } = require('./tempo');

function validaRegole(regole) {
  if (!regole || typeof regole !== 'object' || Array.isArray(regole)) return 'regole: serve un oggetto';
  for (const [k, fasce] of Object.entries(regole)) {
    if (!/^[1-7]$/.test(k)) return `regole: giorno "${k}" non valido (1-7)`;
    if (!Array.isArray(fasce)) return `regole: il giorno ${k} deve essere un elenco di fasce`;
    for (const f of fasce) {
      if (!f || !RE_ORA.test(f.da) || !RE_ORA.test(f.a)) return `regole: fascia non valida nel giorno ${k} (serve HH:MM)`;
      if (f.da === f.a) return `regole: fascia vuota nel giorno ${k}`;
    }
  }
  return null;
}

// Turno teorico di un giorno, o null se quel giorno non si lavora.
function turnoDel(profilo, giorno, festivo, tolleranzaMin = 0) {
  if (!profilo || festivo) return null;
  const fasce = (profilo.regole && profilo.regole[String(giornoSettimana(giorno))]) || [];
  if (!fasce.length) return null;
  const out = [];
  let minuti = 0;
  let base = giorno;
  for (const f of fasce) {
    let inizio = istanteDa(base, f.da);
    // le fasce sono in ordine: una fascia che "torna indietro" è già il giorno dopo
    if (out.length && inizio < out[out.length - 1].fine) {
      base = aggiungiGiorni(base, 1);
      inizio = istanteDa(base, f.da);
    }
    let fine = istanteDa(base, f.a);
    if (fine <= inizio) { base = aggiungiGiorni(base, 1); fine = istanteDa(base, f.a); }
    out.push({ inizio, fine });
    minuti += (fine - inizio) / 60000;
  }
  const mezzanotte = istanteDa(aggiungiGiorni(giorno, 1), '00:00');
  const fine = out[out.length - 1].fine;
  return {
    fasce: out,
    inizio: out[0].inizio,
    fine,
    minutiTeorici: Math.round(minuti),
    attraversaMezzanotte: fine > mezzanotte,
    tolleranzaMin,
  };
}

// Giornata lavorativa a cui appartiene una timbratura: di solito il giorno di
// calendario, ma l'uscita di un turno notturno appartiene al giorno prima.
function giornoCompetenza(istante, turnoPer) {
  const g = giornoDi(istante);
  const prima = aggiungiGiorni(g, -1);
  const t = turnoPer(prima);
  if (t && t.attraversaMezzanotte && new Date(istante).getTime() <= t.fine.getTime() + t.tolleranzaMin * 60000) {
    return prima;
  }
  return g;
}

module.exports = { validaRegole, turnoDel, giornoCompetenza };
