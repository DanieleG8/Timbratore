'use strict';
// Correzioni (amministratori/HR) e timbratura dimenticata (dipendente).
// Ogni intervento lascia la timbratura originale (annullata, non cancellata)
// e una riga nel registro `correzione`.

const { giornoDi, aggiungiGiorni, istanteDa, giornoValido, RE_ORA } = require('../core/tempo');
const { giornoCompetenza } = require('../core/profili');
const { interpretaGiornata } = require('../core/giornata');
const { caricaCalendario } = require('./calendario');
const T = require('./timbrature');
const { richiesta, nonTrovato, vietato, conflitto } = require('../errori');

const VERSI = ['entrata', 'uscita'];

async function competenza(q, personaId, istante) {
  const g = giornoDi(istante);
  const cal = await caricaCalendario(q, personaId, aggiungiGiorni(g, -1), g);
  return giornoCompetenza(istante, cal.turnoPer);
}

// Verso con cui la timbratura conta oggi nella sua giornata.
async function versoAttuale(q, t) {
  const giorno = await competenza(q, t.persona_id, t.istante);
  const g = await T.giornata(q, t.persona_id, giorno);
  const riga = interpretaGiornata(g.tutte).righe.find((x) => x.id === t.id);
  return { giorno, verso: riga ? riga.verso : null };
}

function istanteDaInput(body) {
  if (body.giorno !== undefined || body.ora !== undefined) {
    if (!giornoValido(body.giorno) || !RE_ORA.test(String(body.ora || ''))) throw richiesta('Giorno o ora non validi');
    return istanteDa(body.giorno, body.ora);
  }
  const d = new Date(body.istante);
  if (!body.istante || isNaN(d)) throw richiesta('Istante non valido');
  return d;
}

function motivoObbligatorio(m) {
  const s = String(m || '').trim();
  if (s.length < 3) throw richiesta('Indica il motivo');
  if (s.length > 500) throw richiesta('Motivo troppo lungo (massimo 500 caratteri)');
  return s;
}

async function timbraturaValida(q, id) {
  const t = await T.leggiTimbratura(q, id, true);
  if (!t) throw nonTrovato('Timbratura non trovata');
  if (t.annullata_il) throw conflitto('La timbratura è già stata annullata o sostituita');
  return t;
}

async function nessunDoppione(q, personaId, istante) {
  const vicine = await q.query(
    `SELECT istante FROM timbratura WHERE persona_id = $1 AND annullata_il IS NULL
        AND istante BETWEEN $2::timestamptz - interval '2 minutes' AND $2::timestamptz + interval '2 minutes'`,
    [personaId, istante]);
  if (vicine.length) throw conflitto('Esiste già una timbratura a quell\'ora', 'doppione');
}

/** Correzione da amministratore/HR. */
async function correggi(db, autore, body) {
  const tipo = body.tipo;
  return db.tx(async (q) => {
    if (tipo === 'aggiunta') {
      const personaId = Number(body.persona_id);
      const p = await q.query('SELECT id FROM persona WHERE id = $1', [personaId]);
      if (!p.length) throw nonTrovato('Persona non trovata');
      const istante = istanteDaInput(body);
      const verso = VERSI.includes(body.verso) ? body.verso : 'auto';
      const motivo = motivoObbligatorio(body.motivo);
      await T.verificaMeseAperto(q, await competenza(q, personaId, istante));
      await nessunDoppione(q, personaId, istante);
      const r = await T.registra(q, { persona_id: personaId, istante, verso_dichiarato: verso, origine: 'correzione', creata_da: autore.id, nota: motivo });
      await T.registraCorrezione(q, { tipo, persona_id: personaId, nuova_timbratura_id: r.id, dopo: { istante, verso }, motivo, autore_id: autore.id });
      return r;
    }

    const t = await timbraturaValida(q, body.timbratura_id);
    const attuale = await versoAttuale(q, t);
    await T.verificaMeseAperto(q, attuale.giorno);
    const prima = { istante: t.istante, verso: attuale.verso, origine: t.origine };
  if (!attuale.verso && tipo !== 'annullamento') {
    throw conflitto('Questa chiusura automatica è già superata da un\'uscita successiva: si può solo annullare');
  }

    if (tipo === 'conferma') {
      if (t.origine !== 'automatica' || !t.da_confermare || t.confermata_il) throw conflitto('Non c\'è nulla da confermare');
      const motivo = String(body.motivo || '').trim() || 'Chiusura automatica confermata';
      await q.query('UPDATE timbratura SET confermata_il = now(), confermata_da = $2 WHERE id = $1', [t.id, autore.id]);
      await T.registraCorrezione(q, { tipo, persona_id: t.persona_id, timbratura_id: t.id, prima, motivo, autore_id: autore.id });
      return { id: t.id, giorno: attuale.giorno };
    }

    const motivo = motivoObbligatorio(body.motivo);
    if (tipo === 'annullamento') {
      await T.annulla(q, t.id, motivo, autore.id);
      await T.registraCorrezione(q, { tipo, persona_id: t.persona_id, timbratura_id: t.id, prima, motivo, autore_id: autore.id });
      return { id: t.id, giorno: attuale.giorno };
    }

    let istante = new Date(t.istante), verso = attuale.verso;
    if (tipo === 'spostamento') {
      istante = istanteDaInput(body);
      await T.verificaMeseAperto(q, await competenza(q, t.persona_id, istante));
    } else if (tipo === 'verso') {
      if (!VERSI.includes(body.verso)) throw richiesta('Verso non valido: entrata o uscita');
      verso = body.verso;
    } else {
      throw richiesta('Tipo di correzione non valido');
    }
    await T.annulla(q, t.id, motivo, autore.id);
    const r = await T.registra(q, {
      persona_id: t.persona_id, istante, verso_dichiarato: verso, origine: 'correzione',
      creata_da: autore.id, sostituisce_id: t.id, nota: motivo,
    });
    await T.registraCorrezione(q, {
      tipo, persona_id: t.persona_id, timbratura_id: t.id, nuova_timbratura_id: r.id,
      prima, dopo: { istante, verso }, motivo, autore_id: autore.id,
    });
    return r;
  });
}

async function maxGiorniManuale(q) {
  const r = await q.query("SELECT valore FROM impostazione WHERE chiave = 'manuale_max_giorni'");
  const n = r.length ? Number(r[0].valore) : 7;
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

/**
 * Timbratura dimenticata, inserita dal dipendente stesso. Conta subito, ma
 * resta marcata «inserita a mano» nel cartellino e nei controlli dell'HR.
 */
async function timbraturaDimenticata(db, persona, body, ora = new Date()) {
  if (!VERSI.includes(body.verso)) throw richiesta('Indica se è un\'entrata o un\'uscita');
  const istante = istanteDaInput(body);
  const motivo = motivoObbligatorio(body.motivo);
  if (istante > ora) throw richiesta('Non si può inserire una timbratura nel futuro');
  return db.tx(async (q) => {
    const max = await maxGiorniManuale(q);
    if (istante < new Date(ora.getTime() - max * 86400000)) {
      throw richiesta(`Si possono inserire solo timbrature degli ultimi ${max} giorni: per quelle più vecchie chiedi all'amministrazione`);
    }
    await T.verificaMeseAperto(q, await competenza(q, persona.id, istante));
    await nessunDoppione(q, persona.id, istante);
    const r = await T.registra(q, {
      persona_id: persona.id, istante, verso_dichiarato: body.verso, origine: 'manuale',
      creata_da: persona.id, nota: motivo,
    });
    await T.registraCorrezione(q, {
      tipo: 'manuale', persona_id: persona.id, nuova_timbratura_id: r.id,
      dopo: { istante, verso: body.verso }, motivo, autore_id: persona.id,
    });
    return r;
  });
}

/** Il dipendente conferma la propria chiusura automatica. */
async function confermaPropria(db, persona, timbraturaId) {
  const t = await T.leggiTimbratura(db, timbraturaId);
  if (!t || t.persona_id !== persona.id) throw nonTrovato('Timbratura non trovata');
  if (t.origine !== 'automatica') throw vietato('Si possono confermare solo le chiusure automatiche');
  return correggi(db, persona, { tipo: 'conferma', timbratura_id: timbraturaId, motivo: 'Confermata dal dipendente' });
}

module.exports = { correggi, timbraturaDimenticata, confermaPropria };
