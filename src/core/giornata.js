'use strict';
// Interpretazione di una giornata. Entrata/uscita NON è un dato salvato: si
// calcola dalla sequenza. La prima timbratura del giorno è un'entrata, le
// successive alternano; un verso dichiarato (tasto esplicito o correzione)
// vince sull'alternanza. Così un'uscita dimenticata non fa slittare i giorni
// successivi, e una correzione rimette a posto la giornata da sola.

const ORDINE_ORIGINE = { automatica: 1 };

function confronta(a, b) {
  const d = new Date(a.istante) - new Date(b.istante);
  if (d) return d;
  const o = (ORDINE_ORIGINE[a.origine] || 0) - (ORDINE_ORIGINE[b.origine] || 0);
  if (o) return o;
  return new Date(a.ricevuta_il || 0) - new Date(b.ricevuta_il || 0);
}

// timbrature: solo quelle valide (non annullate) di UNA giornata.
function interpreta(timbrature) {
  const ord = [...timbrature].sort(confronta);
  let entrata = null;
  const righe = [], intervalli = [], anomalie = [];
  for (const t of ord) {
    const dichiarato = t.verso_dichiarato === 'entrata' || t.verso_dichiarato === 'uscita';
    const verso = dichiarato ? t.verso_dichiarato : (entrata ? 'uscita' : 'entrata');
    if (verso === 'entrata') {
      if (entrata) anomalie.push({ tipo: 'entrata_senza_uscita', timbratura_id: entrata.id });
      entrata = t;
    } else {
      if (!entrata) anomalie.push({ tipo: 'uscita_senza_entrata', timbratura_id: t.id });
      else intervalli.push({ da: new Date(entrata.istante), a: new Date(t.istante), entrata_id: entrata.id, uscita_id: t.id });
      entrata = null;
    }
    righe.push({ ...t, verso });
  }
  if (entrata) anomalie.push({ tipo: 'giornata_aperta', timbratura_id: entrata.id });
  const ms = intervalli.reduce((s, i) => s + Math.max(0, i.a - i.da), 0);
  return {
    righe,
    intervalli,
    minutiLavorati: Math.floor(ms / 60000),
    aperta: !!entrata,
    ultimaEntrata: entrata,
    anomalie,
  };
}

const daConfermare = (t) => t.origine === 'automatica' && t.da_confermare && !t.confermata_il;

/**
 * Timbrature che contano in una giornata. `tutte` comprende le annullate.
 * Un'uscita automatica non ancora confermata conta solo se, senza di lei, la
 * giornata resterebbe aperta: se poi arriva l'uscita vera (terminale rimasto
 * offline, timbratura dimenticata inserita a mano) quella automatica viene
 * «superata» da sola, in qualunque ordine arrivino le timbrature.
 */
function effettive(tutte) {
  const valide = tutte.filter((t) => !t.annullata_il);
  const auto = valide.filter(daConfermare).sort(confronta);
  const resto = valide.filter((t) => !daConfermare(t));
  if (!auto.length) return { usate: resto, superate: [] };
  const r = interpreta(resto);
  const ultima = auto[auto.length - 1];
  if (r.aperta && new Date(ultima.istante) >= new Date(r.ultimaEntrata.istante)) {
    return { usate: [...resto, ultima], superate: auto.slice(0, -1) };
  }
  return { usate: resto, superate: auto };
}

const interpretaGiornata = (tutte) => interpreta(effettive(tutte).usate);

// Riepilogo per cartellino e anomalie. Annullate e superate si mostrano ma non contano.
function riepilogo(giorno, tutte, turno, { passato = false } = {}) {
  const { usate, superate } = effettive(tutte);
  const r = interpreta(usate);
  const anomalie = [...r.anomalie];
  for (const t of usate) if (daConfermare(t)) anomalie.push({ tipo: 'chiusura_da_confermare', timbratura_id: t.id });
  if (passato && turno && !usate.length) anomalie.push({ tipo: 'nessuna_timbratura' });
  const altre = [
    ...tutte.filter((t) => t.annullata_il).map((t) => ({ ...t, verso: null })),
    ...superate.map((t) => ({ ...t, verso: null, superata: true })),
  ];
  return {
    giorno,
    minutiLavorati: r.minutiLavorati,
    minutiTeorici: turno ? turno.minutiTeorici : 0,
    aperta: r.aperta,
    anomalie,
    manuali: usate.some((t) => t.origine === 'manuale'),
    timbrature: [...r.righe, ...altre].sort(confronta),
  };
}

module.exports = { interpreta, interpretaGiornata, effettive, riepilogo, confronta };
