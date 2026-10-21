'use strict';
// Terminale in sede (Raspberry in modalità kiosk).
// Il lettore badge USB si comporta come una tastiera: scrive il codice e
// preme Invio. Ogni timbratura entra subito in una coda salvata sul
// dispositivo e viene inviata al server appena possibile: se la rete cade,
// non si perde nulla. Ogni timbratura ha un id generato qui, quindi un
// reinvio non crea doppioni.

const CHIAVE_TOKEN = 'tb_kiosk_token';
const CHIAVE_CODA = 'tb_kiosk_coda';
const CHIAVE_SCARTATE = 'tb_kiosk_scartate';
const INVIO_OGNI_MS = 5000;
const VERSO_VALE_MS = 10000;

const $ = document.getElementById('kiosk');
const fmtOra = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
const fmtOraSec = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtData = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function h(tag, attr, ...figli) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attr || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const f of figli.flat()) if (f !== null && f !== undefined) el.append(f instanceof Node ? f : String(f));
  return el;
}

function leggi(chiave, predefinito) {
  try { const v = localStorage.getItem(chiave); return v === null ? predefinito : JSON.parse(v); } catch (_) { return predefinito; }
}
function scrivi(chiave, valore) {
  try { localStorage.setItem(chiave, JSON.stringify(valore)); return true; } catch (_) { return false; }
}

// ---------- configurazione iniziale ----------

function schermataConfigurazione(errore) {
  const token = h('input', { type: 'password', placeholder: 'codice del terminale', style: 'width:100%' });
  const err = h('div', { class: 'errore' }, errore || '');
  $.replaceChildren(h('div', { class: 'centro carta pila' },
    h('h2', {}, 'Configura il terminale'),
    h('p', { class: 'tenue' }, 'L\'amministratore crea il terminale in Impostazioni → Terminali e ti dà un codice da incollare qui.'),
    err,
    h('form', {
      class: 'pila',
      onsubmit: async (ev) => {
        ev.preventDefault();
        try {
          const r = await fetch('/api/kiosk/ping', { headers: { authorization: `Bearer ${token.value.trim()}` } });
          if (!r.ok) throw new Error('Codice non valido');
          scrivi(CHIAVE_TOKEN, token.value.trim());
          avvia();
        } catch (e) { err.textContent = e.message; }
      },
    }, token, h('button', { type: 'submit', class: 'primario' }, 'Salva'))));
  token.focus();
}

// ---------- suono ----------

let audio = null;
function bip(ok) {
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = 0.15;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.15 : 0.5));
  } catch (_) { /* niente audio: pazienza */ }
}

// ---------- schermata principale ----------

// atteso = ultima timbratura fatta qui, di cui mostrare l'esito a schermo
const stato = { token: null, verso: null, versoTimer: null, online: null, scartoOrologio: 0, atteso: null };
let elOra, elData, elEsito, elStato, elInput, elTasti;

function mostraEsito(tipo, grande, medio) {
  elEsito.className = `k-esito ${tipo}`;
  elEsito.replaceChildren(h('div', { class: 'grande' }, grande), medio ? h('div', { class: 'medio' }, medio) : null);
  clearTimeout(mostraEsito.t);
  mostraEsito.t = setTimeout(invito, 6000);
}

function invito() {
  elEsito.className = 'k-esito';
  elEsito.replaceChildren(h('div', { class: 'k-invito' }, 'Avvicina il badge al lettore'));
}

function aggiornaStato() {
  const coda = leggi(CHIAVE_CODA, []).length;
  const scartate = leggi(CHIAVE_SCARTATE, []).length;
  elStato.replaceChildren(
    h('span', { class: stato.online === false ? 'offline' : '' }, stato.online === false ? '● Senza rete: le timbrature vengono salvate qui' : '● Collegato'),
    h('span', {},
      coda ? `${coda} da inviare` : 'Tutto inviato',
      scartate ? ` · ${scartate} scartate (orologio?)` : '',
      Math.abs(stato.scartoOrologio) > 120000 ? ' · ⚠ orologio del terminale non allineato' : ''));
}

function scegliVerso(v) {
  stato.verso = stato.verso === v ? null : v;
  clearTimeout(stato.versoTimer);
  if (stato.verso) stato.versoTimer = setTimeout(() => { stato.verso = null; disegnaTasti(); }, VERSO_VALE_MS);
  disegnaTasti();
  elInput.focus();
}

function disegnaTasti() {
  elTasti.replaceChildren(
    h('button', { class: stato.verso === 'entrata' ? 'scelto' : '', onclick: () => scegliVerso('entrata') }, 'Entrata'),
    h('button', { class: stato.verso === 'uscita' ? 'scelto' : '', onclick: () => scegliVerso('uscita') }, 'Uscita'));
}

function nuovoId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function timbra(codice) {
  codice = codice.trim();
  if (!codice) return;
  const t = { id: nuovoId(), codice, istante: new Date().toISOString(), verso: stato.verso || undefined };
  const coda = leggi(CHIAVE_CODA, []);
  coda.push(t);
  if (!scrivi(CHIAVE_CODA, coda)) {
    bip(false);
    return mostraEsito('errore', 'Timbratura NON salvata', 'Memoria del terminale piena: avvisa l\'amministrazione');
  }
  stato.verso = null;
  disegnaTasti();
  bip(true);
  mostraEsito('attesa', `Registrata alle ${fmtOra.format(new Date(t.istante))}`, stato.online === false ? 'Senza rete: verrà inviata appena torna' : 'Invio in corso…');
  stato.atteso = t.id;
  invia();
}

let invioInCorso = false;
async function invia() {
  if (invioInCorso) return;
  invioInCorso = true;
  try {
    const coda = leggi(CHIAVE_CODA, []);
    if (!coda.length) { stato.online = true; return; }
    const lotto = coda.slice(0, 50);
    let r;
    try {
      r = await fetch('/api/kiosk/timbrature', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${stato.token}` },
        body: JSON.stringify({ timbrature: lotto }),
      });
    } catch (_) {
      stato.online = false;
      return;
    }
    if (r.status === 401) { scrivi(CHIAVE_TOKEN, null); return schermataConfigurazione('Il terminale è stato disattivato o il codice non è più valido.'); }
    if (!r.ok) { stato.online = false; return; }
    stato.online = true;
    const { esiti } = await r.json();
    const fatti = new Set();
    const scartate = leggi(CHIAVE_SCARTATE, []);
    for (const e of esiti) {
      const originale = lotto.find((t) => t.id === e.id);
      fatti.add(e.id);
      if (e.esito === 'orario_non_valido' || e.esito === 'non_valida') scartate.push({ ...originale, esito: e.esito });
      if (e.id !== stato.atteso) continue;
      stato.atteso = null;
      if (e.esito === 'ok' || e.esito === 'duplicata') {
        mostraEsito('ok', `${e.verso === 'uscita' ? 'Uscita' : 'Entrata'} ${fmtOra.format(new Date(e.istante))}`, e.nome);
      } else if (e.esito === 'badge_sconosciuto') {
        bip(false);
        mostraEsito('errore', 'Badge non riconosciuto', `Codice ${e.codice}: comunicalo all'amministrazione`);
      } else {
        bip(false);
        mostraEsito('errore', 'Timbratura non accettata', 'Orologio del terminale non corretto: avvisa l\'amministrazione');
      }
    }
    scrivi(CHIAVE_SCARTATE, scartate.slice(-200));
    // rilegge la coda: nel frattempo possono essere arrivate altre timbrature
    scrivi(CHIAVE_CODA, leggi(CHIAVE_CODA, []).filter((t) => !fatti.has(t.id)));
  } finally {
    invioInCorso = false;
    aggiornaStato();
    // una timbratura arrivata durante l'invio parte subito, senza aspettare il prossimo giro
    if (stato.online && stato.atteso && leggi(CHIAVE_CODA, []).some((t) => t.id === stato.atteso)) setTimeout(invia, 0);
  }
}

async function controllaOrologio() {
  try {
    const prima = Date.now();
    const r = await fetch('/api/kiosk/ping', { headers: { authorization: `Bearer ${stato.token}` } });
    if (!r.ok) return;
    const j = await r.json();
    stato.scartoOrologio = (prima + Date.now()) / 2 - new Date(j.ora).getTime();
  } catch (_) { /* offline */ }
}

function avvia() {
  stato.token = leggi(CHIAVE_TOKEN, null);
  if (!stato.token) return schermataConfigurazione();

  elOra = h('div', { class: 'k-ora' });
  elData = h('div', { class: 'k-data' });
  elEsito = h('div', { class: 'k-esito' });
  elTasti = h('div', { class: 'k-tasti' });
  elStato = h('div', { class: 'k-stato' });
  elInput = h('input', { class: 'k-input', autocomplete: 'off', 'aria-label': 'Codice badge' });
  let buffer = '';
  elInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); const c = buffer || elInput.value; buffer = ''; elInput.value = ''; timbra(c); }
  });
  elInput.addEventListener('input', () => { buffer = elInput.value; });
  // il campo nascosto deve avere sempre il focus, anche dopo un tocco sullo schermo
  document.addEventListener('click', () => elInput.focus());
  setInterval(() => { if (document.activeElement !== elInput) elInput.focus(); }, 1000);

  $.replaceChildren(h('div', { class: 'k-orologio' }, elOra, elData), elEsito, elTasti, elStato, elInput);
  const tic = () => { const d = new Date(); elOra.textContent = fmtOraSec.format(d); elData.textContent = fmtData.format(d); };
  tic();
  setInterval(tic, 1000);
  invito();
  disegnaTasti();
  aggiornaStato();
  elInput.focus();
  invia();
  setInterval(() => invia(), INVIO_OGNI_MS);
  controllaOrologio();
  setInterval(controllaOrologio, 10 * 60000);
  window.addEventListener('online', () => invia());
}

// La pagina del terminale deve aprirsi anche se il Raspberry si riavvia senza rete.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw-kiosk.js', { scope: '/kiosk' }).catch(() => {});

avvia();
