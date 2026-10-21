'use strict';
// Timbrature dal terminale in sede. Il terminale le invia a lotti (anche dopo
// ore offline); ognuna ha un id generato sul terminale, quindi un reinvio non
// crea doppioni.

const { giornoDi } = require('../core/tempo');
const T = require('./timbrature');
const { richiesta } = require('../errori');

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FUTURO_MS = 5 * 60000;
const MAX_PASSATO_MS = 30 * 86400000;

async function riceviDaKiosk(db, dispositivo, elementi, ora = new Date()) {
  if (!Array.isArray(elementi) || elementi.length > 200) throw richiesta('Serve un elenco di al massimo 200 timbrature');
  await db.query('UPDATE dispositivo SET ultimo_contatto = now() WHERE id = $1', [dispositivo.id]);
  const esiti = [];
  for (const el of elementi) {
    const id = String((el && el.id) || '');
    if (!RE_UUID.test(id)) { esiti.push({ id, esito: 'non_valida' }); continue; }
    const istante = new Date(el.istante);
    const codice = String(el.codice || '').trim();
    if (isNaN(istante) || !codice || codice.length > 64) { esiti.push({ id, esito: 'non_valida' }); continue; }
    // orologio del terminale sballato (es. Raspberry riavviato senza rete)
    if (istante - ora > MAX_FUTURO_MS || ora - istante > MAX_PASSATO_MS) {
      esiti.push({ id, esito: 'orario_non_valido' });
      continue;
    }
    const giorno = giornoDi(istante);
    const b = await db.query(
      `SELECT p.id, p.nome, p.cognome FROM badge b JOIN persona p ON p.id = b.persona_id
        WHERE b.codice = $1 AND p.attiva AND b.valido_dal <= $2 AND (b.valido_al IS NULL OR b.valido_al >= $2)
        ORDER BY b.valido_dal DESC LIMIT 1`,
      [codice, giorno]);
    if (!b.length) { esiti.push({ id, esito: 'badge_sconosciuto', codice }); continue; }
    const verso = el.verso === 'entrata' || el.verso === 'uscita' ? el.verso : 'auto';
    const r = await db.tx((q) => T.registra(q, {
      id, persona_id: b[0].id, istante, verso_dichiarato: verso, origine: 'kiosk',
      dispositivo_id: dispositivo.id, badge: codice,
    }));
    esiti.push({ id, esito: r.nuova ? 'ok' : 'duplicata', nome: `${b[0].nome} ${b[0].cognome}`, verso: r.verso, istante });
  }
  return esiti;
}

module.exports = { riceviDaKiosk };
