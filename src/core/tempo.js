'use strict';
// Date e ore sempre nel fuso italiano, qualunque sia il fuso del server
// (Railway gira in UTC). Un "giorno" è una stringa 'YYYY-MM-DD'.

const TZ = 'Europe/Rome';
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function parti(d) {
  const o = {};
  for (const p of fmt.formatToParts(d)) o[p.type] = p.value;
  return o;
}

function giornoDi(istante) {
  const p = parti(new Date(istante));
  return `${p.year}-${p.month}-${p.day}`;
}

function oraDi(istante) {
  const p = parti(new Date(istante));
  return `${p.hour}:${p.minute}`;
}

// Minuti di differenza fra ora italiana e UTC in quell'istante (60 o 120).
function offsetMin(d) {
  const p = parti(d);
  const comeUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((comeUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

// Istante corrispondente a giorno + 'HH:MM' ora italiana.
function istanteDa(giorno, hhmm) {
  const [y, m, d] = giorno.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const t = Date.UTC(y, m - 1, d, h, mi);
  const off = offsetMin(new Date(t));
  let r = t - off * 60000;
  const off2 = offsetMin(new Date(r));
  if (off2 !== off) r = t - off2 * 60000;
  return new Date(r);
}

function aggiungiGiorni(giorno, n) {
  const [y, m, d] = giorno.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// 1 = lunedì … 7 = domenica
function giornoSettimana(giorno) {
  const w = new Date(giorno + 'T00:00:00Z').getUTCDay();
  return w === 0 ? 7 : w;
}

function giorniDelMese(mese) {
  const out = [];
  let g = mese + '-01';
  while (g.startsWith(mese)) { out.push(g); g = aggiungiGiorni(g, 1); }
  return out;
}

const RE_GIORNO = /^\d{4}-\d{2}-\d{2}$/;
const RE_MESE = /^\d{4}-(0[1-9]|1[0-2])$/;
const RE_ORA = /^([01]\d|2[0-3]):[0-5]\d$/;

function giornoValido(g) {
  return typeof g === 'string' && RE_GIORNO.test(g) && aggiungiGiorni(g, 0) === g;
}

module.exports = {
  TZ, giornoDi, oraDi, istanteDa, aggiungiGiorni, giornoSettimana, giorniDelMese,
  giornoValido, RE_MESE, RE_ORA,
};
