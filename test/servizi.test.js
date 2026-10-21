'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { nuovoDb, nuovaPersona, ist, NOTTURNO } = require('./aiuto');
const T = require('../src/services/timbrature');
const { eseguiChiusure } = require('../src/services/chiusuraNotturna');
const { correggi, timbraturaDimenticata, confermaPropria } = require('../src/services/correzioni');
const { riceviDaKiosk } = require('../src/services/kiosk');
const anagrafica = require('../src/services/anagrafica');
const riepiloghi = require('../src/services/riepiloghi');

let db;
test.before(async () => { db = await nuovoDb(); });
test.after(async () => { await db.chiudi(); });

const G = '2026-10-14';
const timbra = (persona, giorno, ora, extra = {}) =>
  db.tx((q) => T.registra(q, { persona_id: persona.id, istante: ist(giorno, ora), origine: 'kiosk', ...extra }));
const giornoDi = async (persona, giorno) => (await T.cartellino(db, persona.id, giorno.slice(0, 7), ist('2026-10-31', '12:00')))
  .giorni.find((d) => d.giorno === giorno);
// timbrature che contano (escluse annullate e chiusure automatiche superate)
const valide = (d) => d.timbrature.filter((t) => t.verso);

test('chiusura notturna: chiude a fine turno, una volta sola, da confermare', async () => {
  const p = await nuovaPersona(db);
  await timbra(p, G, '08:31');
  assert.deepEqual(await eseguiChiusure(db, ist(G, '23:00')), []);
  const chiuse = await eseguiChiusure(db, ist('2026-10-15', '00:01'));
  assert.equal(chiuse.filter((c) => c.persona_id === p.id).length, 1);
  // ripetere il giro (o un riavvio) non crea doppioni
  await eseguiChiusure(db, ist('2026-10-15', '00:06'));
  await eseguiChiusure(db, ist('2026-10-16', '09:00'));
  const d = await giornoDi(p, G);
  assert.equal(valide(d).length, 2);
  const auto = valide(d).find((t) => t.origine === 'automatica');
  assert.equal(auto.verso, 'uscita');
  assert.equal(new Date(auto.istante).toISOString(), ist(G, '17:30').toISOString());
  assert.equal(d.minutiLavorati, 539);
  assert.ok(d.anomalie.some((a) => a.tipo === 'chiusura_da_confermare'));
  assert.ok((await db.query("SELECT 1 FROM correzione WHERE tipo = 'chiusura_automatica' AND persona_id = $1", [p.id])).length);
});

test('chiusura notturna: il dipendente conferma la propria chiusura', async () => {
  const p = await nuovaPersona(db);
  await timbra(p, G, '08:30');
  await eseguiChiusure(db, ist('2026-10-15', '00:01'));
  const auto = valide(await giornoDi(p, G)).find((t) => t.origine === 'automatica');
  const altro = await nuovaPersona(db);
  await assert.rejects(confermaPropria(db, altro, auto.id), /non trovata/);
  await confermaPropria(db, p, auto.id);
  const d = await giornoDi(p, G);
  assert.ok(!d.anomalie.some((a) => a.tipo === 'chiusura_da_confermare'));
});

test('uscita vera arrivata dopo (terminale offline) sostituisce quella automatica', async () => {
  const p = await nuovaPersona(db);
  await timbra(p, G, '08:30');
  await eseguiChiusure(db, ist('2026-10-15', '00:01'));
  await timbra(p, G, '18:10');
  const d = await giornoDi(p, G);
  assert.deepEqual(valide(d).map((t) => [t.origine, t.verso]), [['kiosk', 'entrata'], ['kiosk', 'uscita']]);
  assert.equal(d.minutiLavorati, 9 * 60 + 40);
  assert.equal(d.anomalie.length, 0);
  assert.ok(d.timbrature.some((t) => t.origine === 'automatica' && t.superata));
});

test('uscita vera prima dell\'orario automatico: vale quella vera', async () => {
  const p = await nuovaPersona(db);
  await timbra(p, G, '08:30');
  await eseguiChiusure(db, ist('2026-10-15', '00:01'));
  await timbraturaDimenticata(db, p, { giorno: G, ora: '16:00', verso: 'uscita', motivo: 'uscito prima' }, ist('2026-10-15', '09:00'));
  const d = await giornoDi(p, G);
  assert.equal(d.minutiLavorati, 450);
  assert.equal(d.anomalie.length, 0);
});

test('terminale offline: pausa e uscita arrivano dopo la chiusura, in qualunque ordine', async () => {
  for (const ordine of [['12:30', '13:30'], ['13:30', '12:30'], ['12:30', '13:30', '17:45']]) {
    const p = await nuovaPersona(db);
    await timbra(p, G, '08:30');
    await eseguiChiusure(db, ist('2026-10-15', '00:01'));
    for (const o of ordine) await timbra(p, G, o);
    const d = await giornoDi(p, G);
    assert.equal(d.aperta, false, ordine.join(','));
    // senza uscita vera vale la chiusura automatica delle 17:30
    assert.equal(d.minutiLavorati, ordine.length === 3 ? 495 : 480, ordine.join(','));
  }
});

test('una pausa pranzo aggiunta dopo non annulla la chiusura automatica', async () => {
  const p = await nuovaPersona(db);
  await timbra(p, G, '08:30');
  await eseguiChiusure(db, ist('2026-10-15', '00:01'));
  const admin = await nuovaPersona(db, { ruoli: ['admin'] });
  await correggi(db, admin, { tipo: 'aggiunta', persona_id: p.id, giorno: G, ora: '12:30', verso: 'uscita', motivo: 'pausa dimenticata' });
  await correggi(db, admin, { tipo: 'aggiunta', persona_id: p.id, giorno: G, ora: '13:30', verso: 'entrata', motivo: 'pausa dimenticata' });
  const d = await giornoDi(p, G);
  assert.equal(d.aperta, false);
  assert.ok(valide(d).some((t) => t.origine === 'automatica'));
  assert.equal(d.minutiLavorati, 480);
});

test('chiusura notturna: rientro serale dopo il turno chiude a 0 ore', async () => {
  const p = await nuovaPersona(db);
  await timbra(p, G, '08:30');
  await timbra(p, G, '17:30');
  await timbra(p, G, '20:00');
  await eseguiChiusure(db, ist('2026-10-15', '00:01'));
  const d = await giornoDi(p, G);
  assert.equal(d.minutiLavorati, 540);
  assert.equal(d.aperta, false);
});

test('turno notturno: chiusura dopo la fine del turno, giornata del giorno prima', async () => {
  const p = await nuovaPersona(db, { regole: NOTTURNO });
  await timbra(p, G, '22:00');
  const ch = (await eseguiChiusure(db, ist('2026-10-15', '00:01'))).filter((c) => c.persona_id === p.id);
  assert.equal(ch.length, 0);
  const ch2 = (await eseguiChiusure(db, ist('2026-10-15', '08:01'))).filter((c) => c.persona_id === p.id);
  assert.equal(ch2.length, 1);
  assert.equal(ch2[0].giorno, G);
  const d = await giornoDi(p, G);
  assert.equal(d.minutiLavorati, 480);
});

test('correzioni amministratore: sposta, inverte, annulla; tutto tracciato', async () => {
  const p = await nuovaPersona(db);
  const admin = await nuovaPersona(db, { ruoli: ['admin'] });
  const e = await timbra(p, G, '08:30');
  const u = await timbra(p, G, '08:31'); // doppia passata
  await timbra(p, G, '17:30');
  let d = await giornoDi(p, G);
  assert.deepEqual(valide(d).map((t) => t.verso), ['entrata', 'uscita', 'entrata']);

  await assert.rejects(correggi(db, admin, { tipo: 'annullamento', timbratura_id: u.id, motivo: '' }), /motivo/);
  await correggi(db, admin, { tipo: 'annullamento', timbratura_id: u.id, motivo: 'doppia passata' });
  d = await giornoDi(p, G);
  assert.deepEqual(valide(d).map((t) => t.verso), ['entrata', 'uscita']);
  assert.equal(d.minutiLavorati, 540);
  assert.equal(d.timbrature.length, 3); // l'originale resta visibile, annullata

  await correggi(db, admin, { tipo: 'spostamento', timbratura_id: e.id, giorno: G, ora: '08:00', motivo: 'arrivato prima' });
  d = await giornoDi(p, G);
  assert.equal(d.minutiLavorati, 570);
  const nuova = valide(d).find((t) => t.origine === 'correzione');
  assert.equal(nuova.sostituisce_id, e.id);
  assert.equal(nuova.verso, 'entrata');

  await assert.rejects(correggi(db, admin, { tipo: 'spostamento', timbratura_id: e.id, giorno: G, ora: '07:00', motivo: 'ancora' }), /già stata annullata/);

  const reg = await db.query('SELECT tipo, autore_id, motivo FROM correzione WHERE persona_id = $1 ORDER BY id', [p.id]);
  assert.deepEqual(reg.map((r) => r.tipo), ['annullamento', 'spostamento']);
  assert.ok(reg.every((r) => r.autore_id === admin.id));
});

test('correzioni: forzare il verso rimette a posto la giornata', async () => {
  const p = await nuovaPersona(db);
  const admin = await nuovaPersona(db, { ruoli: ['admin'] });
  // entrata dimenticata: c'è solo l'uscita delle 17:30, che viene letta come entrata
  const t = await timbra(p, G, '17:30');
  assert.equal(t.verso, 'entrata');
  await correggi(db, admin, { tipo: 'verso', timbratura_id: t.id, verso: 'uscita', motivo: 'era un\'uscita' });
  await correggi(db, admin, { tipo: 'aggiunta', persona_id: p.id, giorno: G, ora: '08:30', verso: 'entrata', motivo: 'entrata dimenticata' });
  const d = await giornoDi(p, G);
  assert.deepEqual(valide(d).map((x) => x.verso), ['entrata', 'uscita']);
  assert.equal(d.minutiLavorati, 540);
});

test('timbratura dimenticata inserita dal dipendente: conta ed è segnata come manuale', async () => {
  const p = await nuovaPersona(db);
  await timbra(p, G, '08:30');
  const ora = ist('2026-10-15', '09:00');
  await assert.rejects(timbraturaDimenticata(db, p, { giorno: G, ora: '17:30', verso: 'uscita', motivo: '' }, ora), /motivo/);
  await assert.rejects(timbraturaDimenticata(db, p, { giorno: G, ora: '17:30', motivo: 'dimenticata' }, ora), /entrata o un'uscita/);
  await assert.rejects(timbraturaDimenticata(db, p, { giorno: '2026-10-15', ora: '18:00', verso: 'uscita', motivo: 'futuro' }, ora), /futuro/);
  await assert.rejects(timbraturaDimenticata(db, p, { giorno: '2026-10-01', ora: '17:30', verso: 'uscita', motivo: 'vecchia' }, ora), /ultimi 7 giorni/);
  await timbraturaDimenticata(db, p, { giorno: G, ora: '17:30', verso: 'uscita', motivo: 'dimenticata' }, ora);
  await assert.rejects(timbraturaDimenticata(db, p, { giorno: G, ora: '17:31', verso: 'uscita', motivo: 'di nuovo' }, ora), /già una timbratura/);
  const d = await giornoDi(p, G);
  assert.equal(d.minutiLavorati, 540);
  assert.equal(d.manuali, true);
  const m = valide(d).find((t) => t.origine === 'manuale');
  assert.equal(m.creata_da, p.id);
  assert.equal(m.nota, 'dimenticata');
  // l'HR la ritrova nell'elenco da controllare
  const an = await riepiloghi.anomalie(db, G, G, ora);
  assert.ok(an.some((x) => x.persona.id === p.id && x.manuali));
});

test('mese chiuso: niente correzioni né timbrature a mano finché non si riapre', async () => {
  const p = await nuovaPersona(db);
  const admin = await nuovaPersona(db, { ruoli: ['admin'] });
  const t = await timbra(p, '2026-09-10', '08:30');
  await anagrafica.chiudiMese(db, '2026-09', admin.id);
  await assert.rejects(correggi(db, admin, { tipo: 'annullamento', timbratura_id: t.id, motivo: 'prova' }), /chiuso/);
  await assert.rejects(correggi(db, admin, { tipo: 'aggiunta', persona_id: p.id, giorno: '2026-09-10', ora: '17:30', verso: 'uscita', motivo: 'prova' }), /chiuso/);
  await assert.rejects(timbraturaDimenticata(db, p, { giorno: '2026-09-30', ora: '17:30', verso: 'uscita', motivo: 'prova' }, ist('2026-10-02', '09:00')), /chiuso/);
  // la chiusura automatica non tocca un mese chiuso
  assert.equal((await eseguiChiusure(db, ist('2026-10-01', '00:30'), 30)).filter((c) => c.persona_id === p.id).length, 0);
  await anagrafica.riapriMese(db, '2026-09');
  await correggi(db, admin, { tipo: 'annullamento', timbratura_id: t.id, motivo: 'prova' });
});

test('terminale: badge, invii ripetuti, orologio sballato, badge sconosciuto', async () => {
  const p = await nuovaPersona(db, { badge: 'ABC123' });
  const disp = await anagrafica.creaDispositivo(db, { nome: 'Ingresso' });
  assert.equal((await anagrafica.dispositivoDaToken(db, disp.token)).id, disp.id);
  assert.equal(await anagrafica.dispositivoDaToken(db, 'sbagliato'), null);
  const ora = ist(G, '18:00');
  const id1 = crypto.randomUUID(), id2 = crypto.randomUUID();
  const lotto = [
    { id: id1, codice: 'ABC123', istante: ist(G, '08:30').toISOString() },
    { id: id2, codice: 'ABC123', istante: ist(G, '17:30').toISOString() },
  ];
  const e1 = await riceviDaKiosk(db, disp, lotto, ora);
  assert.deepEqual(e1.map((e) => [e.esito, e.verso]), [['ok', 'entrata'], ['ok', 'uscita']]);
  const e2 = await riceviDaKiosk(db, disp, lotto, ora); // la risposta era andata persa: reinvio
  assert.deepEqual(e2.map((e) => e.esito), ['duplicata', 'duplicata']);
  assert.equal((await giornoDi(p, G)).minutiLavorati, 540);

  const e3 = await riceviDaKiosk(db, disp, [
    { id: crypto.randomUUID(), codice: 'ABC123', istante: '1970-01-01T00:00:00Z' },
    { id: crypto.randomUUID(), codice: 'NONESISTE', istante: ora.toISOString() },
    { id: 'non-uuid', codice: 'ABC123', istante: ora.toISOString() },
  ], ora);
  assert.deepEqual(e3.map((e) => e.esito), ['orario_non_valido', 'badge_sconosciuto', 'non_valida']);
  assert.equal(e3[1].codice, 'NONESISTE');
});

test('anagrafica: un badge per persona, profilo dal giorno indicato', async () => {
  const a = await nuovaPersona(db, { regole: null });
  const b = await nuovaPersona(db, { regole: null });
  await anagrafica.assegnaBadge(db, a.id, { codice: 'X1', dal: '2026-10-01' });
  await assert.rejects(anagrafica.assegnaBadge(db, b.id, { codice: 'X1' }), /già assegnato/);
  await anagrafica.assegnaBadge(db, a.id, { codice: 'X2', dal: '2026-10-10' });
  const badge = await db.query('SELECT codice, valido_al FROM badge WHERE persona_id = $1 ORDER BY id', [a.id]);
  assert.deepEqual(badge, [{ codice: 'X1', valido_al: '2026-10-09' }, { codice: 'X2', valido_al: null }]);

  const p1 = await anagrafica.salvaProfilo(db, null, { nome: `Full ${a.id}`, regole: { 1: [{ da: '08:00', a: '17:00' }] } });
  const p2 = await anagrafica.salvaProfilo(db, null, { nome: `Part ${a.id}`, regole: { 1: [{ da: '08:00', a: '12:00' }] } });
  await assert.rejects(anagrafica.salvaProfilo(db, null, { nome: 'Rotto', regole: { 1: [{ da: '8', a: '12:00' }] } }), /HH:MM/);
  await anagrafica.assegnaProfilo(db, a.id, { profilo_id: p1.id, dal: '2026-01-01' });
  await anagrafica.assegnaProfilo(db, a.id, { profilo_id: p2.id, dal: '2026-10-19' });
  const ass = await db.query('SELECT profilo_id, dal, al FROM assegnazione_orario WHERE persona_id = $1 ORDER BY dal', [a.id]);
  assert.deepEqual(ass, [{ profilo_id: p1.id, dal: '2026-01-01', al: '2026-10-18' }, { profilo_id: p2.id, dal: '2026-10-19', al: null }]);
});

test('presenti adesso', async () => {
  const p = await nuovaPersona(db);
  await timbra(p, '2026-10-20', '08:30');
  const pr = await riepiloghi.presenti(db, ist('2026-10-20', '10:00'));
  assert.ok(pr.some((x) => x.persona.id === p.id));
  await timbra(p, '2026-10-20', '12:00');
  assert.ok(!(await riepiloghi.presenti(db, ist('2026-10-20', '12:05'))).some((x) => x.persona.id === p.id));
});

test('cartellino: la giornata di oggi ancora aperta non è un\'anomalia', async () => {
  const p = await nuovaPersona(db);
  await timbra(p, '2026-10-20', '08:30');
  const c = await T.cartellino(db, p.id, '2026-10', ist('2026-10-20', '11:00'));
  assert.deepEqual(c.giorni.find((d) => d.giorno === '2026-10-20').anomalie, []);
  const dopo = await T.cartellino(db, p.id, '2026-10', ist('2026-10-21', '11:00'));
  assert.ok(dopo.giorni.find((d) => d.giorno === '2026-10-20').anomalie.some((a) => a.tipo === 'giornata_aperta'));
});
