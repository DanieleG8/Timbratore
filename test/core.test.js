'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { istanteDa, giornoDi, oraDi, aggiungiGiorni, giorniDelMese } = require('../src/core/tempo');
const { pasqua, festivitaNazionali } = require('../src/core/festivita');
const { turnoDel, giornoCompetenza, validaRegole } = require('../src/core/profili');
const { interpreta, riepilogo } = require('../src/core/giornata');
const { decidiChiusura } = require('../src/core/chiusura');
const { ORARIO_UFFICIO, NOTTURNO } = require('./aiuto');

let n = 0;
const tb = (istante, extra = {}) => ({ id: `t${++n}`, istante, verso_dichiarato: 'auto', origine: 'kiosk', ...extra });

test('ora italiana anche col cambio d\'ora', () => {
  assert.equal(istanteDa('2026-07-01', '08:30').toISOString(), '2026-07-01T06:30:00.000Z'); // ora legale
  assert.equal(istanteDa('2026-12-01', '08:30').toISOString(), '2026-12-01T07:30:00.000Z'); // ora solare
  assert.equal(istanteDa('2026-10-25', '12:00').toISOString(), '2026-10-25T11:00:00.000Z'); // giorno del cambio
  assert.equal(giornoDi(new Date('2026-10-20T22:30:00Z')), '2026-10-21');
  assert.equal(oraDi(new Date('2026-10-20T22:30:00Z')), '00:30');
  assert.equal(aggiungiGiorni('2026-12-31', 1), '2027-01-01');
  assert.equal(giorniDelMese('2026-02').length, 28);
});

test('festività nazionali con Pasqua mobile', () => {
  assert.equal(pasqua(2026), '2026-04-05');
  assert.equal(pasqua(2027), '2027-03-28');
  const f = festivitaNazionali(2026);
  assert.equal(f.get('2026-04-06'), "Lunedì dell'Angelo");
  assert.ok(f.has('2026-10-04'));
  assert.ok(!festivitaNazionali(2025).has('2025-10-04'));
});

test('regole del profilo validate', () => {
  assert.equal(validaRegole(ORARIO_UFFICIO), null);
  assert.match(validaRegole({ 8: [] }), /non valido/);
  assert.match(validaRegole({ 1: [{ da: '8:30', a: '12:00' }] }), /HH:MM/);
});

test('turno teorico e turno notturno', () => {
  const t = turnoDel({ regole: ORARIO_UFFICIO }, '2026-10-14', false);
  assert.equal(t.minutiTeorici, 480);
  assert.equal(t.fine.toISOString(), istanteDa('2026-10-14', '17:30').toISOString());
  assert.equal(t.attraversaMezzanotte, false);
  assert.equal(turnoDel({ regole: ORARIO_UFFICIO }, '2026-10-14', true), null); // festivo
  const nn = turnoDel({ regole: NOTTURNO }, '2026-10-14', false, 120);
  assert.equal(nn.attraversaMezzanotte, true);
  assert.equal(nn.fine.toISOString(), istanteDa('2026-10-15', '06:00').toISOString());
  assert.equal(nn.minutiTeorici, 480);
});

test('uscita di un turno notturno appartiene al giorno prima', () => {
  const turnoPer = (g) => turnoDel({ regole: NOTTURNO }, g, false, 120);
  assert.equal(giornoCompetenza(istanteDa('2026-10-15', '06:10'), turnoPer), '2026-10-14');
  assert.equal(giornoCompetenza(istanteDa('2026-10-15', '21:55'), turnoPer), '2026-10-15');
  const ufficio = (g) => turnoDel({ regole: ORARIO_UFFICIO }, g, false);
  assert.equal(giornoCompetenza(istanteDa('2026-10-15', '00:30'), ufficio), '2026-10-15');
});

test('entrata e uscita si calcolano dalla sequenza della giornata', () => {
  const g = '2026-10-14';
  const r = interpreta([tb(istanteDa(g, '17:31')), tb(istanteDa(g, '08:29')), tb(istanteDa(g, '13:30')), tb(istanteDa(g, '12:31'))]);
  assert.deepEqual(r.righe.map((x) => x.verso), ['entrata', 'uscita', 'entrata', 'uscita']);
  assert.equal(r.minutiLavorati, 4 * 60 + 2 + 4 * 60 + 1);
  assert.equal(r.aperta, false);
});

test('un\'uscita dimenticata non fa slittare il giorno dopo', () => {
  const ieri = interpreta([tb(istanteDa('2026-10-13', '08:30'))]);
  assert.equal(ieri.aperta, true);
  // la giornata successiva riparte da capo: la prima è un'entrata
  const oggi = interpreta([tb(istanteDa('2026-10-14', '08:30')), tb(istanteDa('2026-10-14', '17:30'))]);
  assert.deepEqual(oggi.righe.map((x) => x.verso), ['entrata', 'uscita']);
});

test('il verso dichiarato vince sull\'alternanza e le anomalie vengono segnalate', () => {
  const g = '2026-10-14';
  const r = interpreta([tb(istanteDa(g, '08:30'), { verso_dichiarato: 'uscita' }), tb(istanteDa(g, '09:00'))]);
  assert.deepEqual(r.righe.map((x) => x.verso), ['uscita', 'entrata']);
  assert.deepEqual(r.anomalie.map((a) => a.tipo), ['uscita_senza_entrata', 'giornata_aperta']);
});

test('riepilogo: annullate non contano, manuali segnalate, giorno vuoto passato segnalato', () => {
  const g = '2026-10-14';
  const turno = turnoDel({ regole: ORARIO_UFFICIO }, g, false);
  const r = riepilogo(g, [
    tb(istanteDa(g, '08:30')),
    tb(istanteDa(g, '09:00'), { annullata_il: new Date() }),
    tb(istanteDa(g, '17:30'), { origine: 'manuale', verso_dichiarato: 'uscita' }),
  ], turno);
  assert.equal(r.minutiLavorati, 540);
  assert.equal(r.manuali, true);
  assert.equal(r.timbrature.length, 3);
  assert.equal(r.timbrature.find((t) => t.annullata_il).verso, null);
  assert.deepEqual(riepilogo(g, [], turno, { passato: true }).anomalie, [{ tipo: 'nessuna_timbratura' }]);
});

test('chiusura automatica: alle 24 a fine turno', () => {
  const g = '2026-10-14';
  const turno = turnoDel({ regole: ORARIO_UFFICIO }, g, false);
  const aperta = [tb(istanteDa(g, '08:30'))];
  assert.equal(decidiChiusura({ giorno: g, timbrature: aperta, turno, ora: istanteDa(g, '23:59') }), null);
  const d = decidiChiusura({ giorno: g, timbrature: aperta, turno, ora: istanteDa('2026-10-15', '00:00') });
  assert.equal(d.istante.toISOString(), istanteDa(g, '17:30').toISOString());
  assert.equal(d.zeroOre, false);
  const chiusa = [tb(istanteDa(g, '08:30')), tb(istanteDa(g, '17:30'))];
  assert.equal(decidiChiusura({ giorno: g, timbrature: chiusa, turno, ora: istanteDa('2026-10-15', '01:00') }), null);
});

test('chiusura automatica: casi limite', () => {
  const g = '2026-10-14';
  const turno = turnoDel({ regole: ORARIO_UFFICIO }, g, false);
  const dopo = istanteDa('2026-10-15', '00:05');
  // rientro serale dopo la fine del turno: 0 ore, non un'uscita prima dell'entrata
  const sera = decidiChiusura({ giorno: g, timbrature: [tb(istanteDa(g, '19:00'))], turno, ora: dopo });
  assert.equal(sera.istante.toISOString(), istanteDa(g, '19:00').toISOString());
  assert.equal(sera.zeroOre, true);
  // nessun turno (weekend, festivo)
  const libero = decidiChiusura({ giorno: g, timbrature: [tb(istanteDa(g, '10:00'))], turno: null, ora: dopo });
  assert.equal(libero.zeroOre, true);
  // turno notturno: si aspetta la fine del turno più la tolleranza
  const nt = turnoDel({ regole: NOTTURNO }, g, false, 120);
  const notte = [tb(istanteDa(g, '22:00'))];
  assert.equal(decidiChiusura({ giorno: g, timbrature: notte, turno: nt, ora: istanteDa('2026-10-15', '07:59') }), null);
  const d = decidiChiusura({ giorno: g, timbrature: notte, turno: nt, ora: istanteDa('2026-10-15', '08:00') });
  assert.equal(d.istante.toISOString(), istanteDa('2026-10-15', '06:00').toISOString());
});
