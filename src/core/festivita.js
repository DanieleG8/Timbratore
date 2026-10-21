'use strict';
// Festività nazionali italiane. Il patrono e le chiusure aziendali si
// aggiungono nella tabella `festivita`.

const pad = (n) => String(n).padStart(2, '0');

// Domenica di Pasqua (algoritmo di Meeus/Jones/Butcher).
function pasqua(anno) {
  const a = anno % 19, b = Math.floor(anno / 100), c = anno % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mese = Math.floor((h + l - 7 * m + 114) / 31);
  const giorno = ((h + l - 7 * m + 114) % 31) + 1;
  return `${anno}-${pad(mese)}-${pad(giorno)}`;
}

function festivitaNazionali(anno) {
  const m = new Map([
    [`${anno}-01-01`, 'Capodanno'],
    [`${anno}-01-06`, 'Epifania'],
    [`${anno}-04-25`, 'Festa della Liberazione'],
    [`${anno}-05-01`, 'Festa del Lavoro'],
    [`${anno}-06-02`, 'Festa della Repubblica'],
    [`${anno}-08-15`, 'Ferragosto'],
    [`${anno}-11-01`, 'Ognissanti'],
    [`${anno}-12-08`, 'Immacolata Concezione'],
    [`${anno}-12-25`, 'Natale'],
    [`${anno}-12-26`, 'Santo Stefano'],
  ]);
  // San Francesco d'Assisi torna festa nazionale dal 2026.
  if (anno >= 2026) m.set(`${anno}-10-04`, "San Francesco d'Assisi");
  const p = pasqua(anno);
  m.set(p, 'Pasqua');
  const [y, mm, dd] = p.split('-').map(Number);
  m.set(new Date(Date.UTC(y, mm - 1, dd + 1)).toISOString().slice(0, 10), "Lunedì dell'Angelo");
  return m;
}

module.exports = { pasqua, festivitaNazionali };
