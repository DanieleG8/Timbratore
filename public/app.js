'use strict';
// Web app: dipendenti (oggi, cartellino, timbratura dimenticata) e
// amministrazione (da sistemare, persone, correzioni, presenti, impostazioni).
// JavaScript senza librerie; parla solo con le API JSON del server.

const $app = document.getElementById('app');

// ---------- utilità ----------

function h(tag, attr, ...figli) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attr || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const aggiungi = (f) => {
    if (f === null || f === undefined || f === false) return;
    if (Array.isArray(f)) f.forEach(aggiungi);
    else el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  };
  figli.forEach(aggiungi);
  return el;
}

async function api(metodo, percorso, corpo) {
  const r = await fetch(percorso, {
    method: metodo,
    headers: corpo !== undefined ? { 'content-type': 'application/json' } : {},
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    credentials: 'same-origin',
  });
  let dati = null;
  try { dati = await r.json(); } catch (_) { /* risposta vuota */ }
  if (!r.ok) {
    const e = new Error((dati && dati.errore) || `Errore ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return dati;
}

const TZ = 'Europe/Rome';
const fmtOra = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fmtGiorno = new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC', weekday: 'short', day: '2-digit' });
const fmtGiornoLungo = new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const fmtMese = new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const fmtData = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

const ora = (istante) => fmtOra.format(new Date(istante));
const oggi = () => fmtData.format(new Date());
const meseDi = (g) => g.slice(0, 7);
const dataG = (g) => new Date(g + 'T12:00:00Z');
const durata = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
function spostaMese(mese, n) {
  const [y, m] = mese.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

const ANOMALIE = {
  giornata_aperta: 'Manca l\'uscita',
  uscita_senza_entrata: 'Manca l\'entrata',
  entrata_senza_uscita: 'Due entrate di fila',
  chiusura_da_confermare: 'Chiusura automatica da confermare',
  nessuna_timbratura: 'Nessuna timbratura',
};
const ORIGINI = {
  kiosk: 'terminale', web: 'da remoto', manuale: 'inserita a mano', correzione: 'correzione',
  automatica: 'chiusura automatica', importata: 'importata',
};

function messaggio(el, testo, tipo = 'errore') {
  el.replaceChildren(testo ? h('div', { class: `messaggio ${tipo}` }, testo) : '');
}

// Finestra modale con campi; onConferma(valori) può lanciare un errore da mostrare.
function dialogo(titolo, campi, onConferma, { testoConferma = 'Conferma', nota } = {}) {
  const err = h('div');
  const input = {};
  const corpo = campi.map((c) => {
    let el;
    if (c.tipo === 'select') el = h('select', { name: c.nome }, c.opzioni.map(([v, t]) => h('option', { value: v, selected: v === c.valore }, t)));
    else el = h('input', { name: c.nome, type: c.tipo || 'text', value: c.valore || '', required: c.obbligatorio, placeholder: c.segnaposto });
    input[c.nome] = el;
    return h('label', {}, c.etichetta, el);
  });
  const d = h('dialog', { class: 'carta', style: 'max-width:420px;width:calc(100% - 32px)' },
    h('form', {
      method: 'dialog', class: 'pila',
      onsubmit: async (ev) => {
        ev.preventDefault();
        const valori = Object.fromEntries(Object.entries(input).map(([k, el]) => [k, el.value]));
        try { await onConferma(valori); d.close(); d.remove(); } catch (e) { messaggio(err, e.message); }
      },
    },
    h('h2', {}, titolo), nota ? h('p', { class: 'tenue' }, nota) : null, corpo, err,
    h('div', { class: 'riga' },
      h('button', { type: 'submit', class: 'primario' }, testoConferma),
      h('button', { type: 'button', onclick: () => { d.close(); d.remove(); } }, 'Annulla'))));
  document.body.append(d);
  d.showModal();
}

// ---------- accesso ----------

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const casuale = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function loginMicrosoft(cfg) {
  const verifier = casuale(32);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const stato = { verifier, state: casuale(16), nonce: casuale(16) };
  sessionStorage.setItem('tb_ms', JSON.stringify(stato));
  const q = new URLSearchParams({
    client_id: cfg.clientId, response_type: 'code', redirect_uri: location.origin + '/',
    scope: 'openid profile email', code_challenge: challenge, code_challenge_method: 'S256',
    state: stato.state, nonce: stato.nonce, response_mode: 'query', prompt: 'select_account',
  });
  location.href = `https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/authorize?${q}`;
}

// Ritorno da Microsoft con ?code=…: scambio del codice (PKCE) e login sul server.
async function completaMicrosoft(params) {
  const salvato = JSON.parse(sessionStorage.getItem('tb_ms') || 'null');
  sessionStorage.removeItem('tb_ms');
  history.replaceState(null, '', '/');
  if (!salvato || salvato.state !== params.get('state')) throw new Error('Accesso Microsoft non valido, riprova');
  const cfg = (await api('GET', '/api/auth/config')).microsoft;
  const r = await fetch(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId, grant_type: 'authorization_code', code: params.get('code'),
      redirect_uri: location.origin + '/', code_verifier: salvato.verifier, scope: 'openid profile email',
    }),
  });
  const t = await r.json();
  if (!r.ok || !t.id_token) throw new Error('Accesso Microsoft non riuscito');
  const payload = JSON.parse(atob(t.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.nonce !== salvato.nonce) throw new Error('Accesso Microsoft non valido, riprova');
  await api('POST', '/api/auth/oidc', { provider: 'microsoft', id_token: t.id_token });
}

function caricaGoogle(cfg, contenitore, err) {
  const s = h('script', { src: 'https://accounts.google.com/gsi/client', async: true });
  s.onload = () => {
    window.google.accounts.id.initialize({
      client_id: cfg.clientId, hd: cfg.hd, ux_mode: 'popup',
      callback: async (r) => {
        try { await api('POST', '/api/auth/oidc', { provider: 'google', id_token: r.credential }); avvio(); } catch (e) { messaggio(err, e.message); }
      },
    });
    window.google.accounts.id.renderButton(contenitore, { theme: 'outline', size: 'large', text: 'signin_with', width: 300 });
  };
  document.head.append(s);
}

async function schermataLogin(avvisoIniziale) {
  const cfg = await api('GET', '/api/auth/config').catch(() => ({}));
  const err = h('div');
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const google = h('div');
  $app.replaceChildren(h('div', { class: 'centro carta pila' },
    h('h2', {}, 'Timbratore'),
    err,
    cfg.microsoft ? h('button', { class: 'primario', onclick: () => loginMicrosoft(cfg.microsoft) }, 'Accedi con Microsoft') : null,
    cfg.google ? google : null,
    (cfg.microsoft || cfg.google) ? h('p', { class: 'tenue', style: 'margin:4px 0' }, 'oppure con email e password') : null,
    h('form', {
      class: 'pila',
      onsubmit: async (ev) => {
        ev.preventDefault();
        try { await api('POST', '/api/auth/login', { email: email.value, password: pw.value }); avvio(); } catch (e) { messaggio(err, e.message); }
      },
    }, h('label', {}, 'Email', email), h('label', {}, 'Password', pw), h('button', { type: 'submit' }, 'Accedi'))));
  if (avvisoIniziale) messaggio(err, avvisoIniziale);
  if (cfg.google) caricaGoogle(cfg.google, google, err);
}

function schermataAttivazione(token) {
  const err = h('div');
  const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  $app.replaceChildren(h('div', { class: 'centro carta pila' },
    h('h2', {}, 'Scegli la tua password'),
    h('p', { class: 'tenue' }, 'Almeno 10 caratteri. Ti servirà per entrare nel Timbratore.'),
    err,
    h('form', {
      class: 'pila',
      onsubmit: async (ev) => {
        ev.preventDefault();
        if (pw.value !== pw2.value) return messaggio(err, 'Le due password non coincidono');
        try {
          await api('POST', '/api/auth/attiva', { token, password: pw.value });
          history.replaceState(null, '', '/');
          avvio();
        } catch (e) { messaggio(err, e.message); }
      },
    }, h('label', {}, 'Password', pw), h('label', {}, 'Ripeti la password', pw2), h('button', { type: 'submit', class: 'primario' }, 'Salva'))));
}

// ---------- app ----------

const stato = { utente: null, scheda: 'oggi', persona: null, mese: null };

async function avvio() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('attiva')) return schermataAttivazione(hash.get('attiva'));
  const q = new URLSearchParams(location.search);
  if (q.get('code') && q.get('state')) {
    try { await completaMicrosoft(q); } catch (e) { return schermataLogin(e.message); }
  } else if (q.get('error')) {
    history.replaceState(null, '', '/');
    return schermataLogin('Accesso Microsoft annullato');
  }
  try {
    stato.utente = await api('GET', '/api/me');
  } catch (e) {
    return schermataLogin(e.status === 401 ? null : e.message);
  }
  disegna();
}

const SCHEDE = [
  ['oggi', 'Oggi', false],
  ['cartellino', 'Il mio cartellino', false],
  ['sistemare', 'Da sistemare', true],
  ['cartellinoPersona', 'Cartellini', true],
  ['persone', 'Persone', true],
  ['presenti', 'Presenti', true],
  ['impostazioni', 'Impostazioni', true],
];

function disegna() {
  const u = stato.utente;
  const contenuto = h('main');
  $app.replaceChildren(
    h('header', { class: 'barra' },
      h('h1', {}, 'Timbratore'),
      h('span', { class: 'tenue' }, `${u.nome} ${u.cognome}`.trim()),
      h('button', { class: 'piccolo', onclick: async () => { await api('POST', '/api/auth/logout', {}); avvio(); } }, 'Esci')),
    h('nav', { class: 'schede' }, SCHEDE.filter(([, , admin]) => !admin || u.admin).map(([id, nome]) =>
      h('button', { class: stato.scheda === id ? 'attiva' : '', onclick: () => { stato.scheda = id; disegna(); } }, nome))),
    contenuto);
  const viste = { oggi: vistaOggi, cartellino: vistaCartellino, sistemare: vistaDaSistemare, cartellinoPersona: vistaCartellinoPersona, persone: vistaPersone, presenti: vistaPresenti, impostazioni: vistaImpostazioni };
  Promise.resolve(viste[stato.scheda](contenuto)).catch((e) => messaggio(contenuto, e.message));
}

// Una timbratura come "chip": ora, verso, origine.
function chip(t, azioni) {
  const cls = ['chip'];
  if (t.annullata_il || t.superata) cls.push('annullata');
  else if (t.origine === 'manuale') cls.push('manuale');
  else if (t.origine === 'automatica') cls.push('automatica');
  const titolo = [
    ORIGINI[t.origine] || t.origine,
    t.nota ? `«${t.nota}»` : null,
    t.annullata_il ? `annullata: ${t.annullata_motivo || ''}` : null,
    t.superata ? 'superata da un\'uscita successiva' : null,
  ].filter(Boolean).join(' · ');
  const freccia = t.verso === 'entrata' ? '→' : t.verso === 'uscita' ? '←' : '·';
  const segno = t.origine === 'manuale' ? ' ✍' : t.origine === 'automatica' ? ' ⏱' : '';
  return h('span', { class: cls.join(' '), title: titolo }, `${freccia} ${ora(t.istante)}${segno}`, azioni || null);
}

function legenda() {
  return h('p', { class: 'tenue', style: 'font-size:13px' },
    '→ entrata · ← uscita · ✍ inserita a mano · ⏱ chiusura automatica a mezzanotte · barrata = annullata o sostituita');
}

// Tabella del cartellino; azioniGiorno(giorno) e azioniTimbratura(t, giorno) aggiungono bottoni.
function tabellaCartellino(dati, { azioniGiorno, azioniTimbratura } = {}) {
  const righe = dati.giorni.map((g) => {
    const dow = dataG(g.giorno).getUTCDay();
    return h('tr', { class: dow === 0 || dow === 6 || g.festivita ? 'weekend' : '' },
      h('td', {}, fmtGiorno.format(dataG(g.giorno)), g.festivita ? h('div', { class: 'tenue', style: 'font-size:12px' }, g.festivita) : null),
      h('td', {}, g.timbrature.map((t) => chip(t, azioniTimbratura && !t.annullata_il && !t.superata ? azioniTimbratura(t, g) : null)),
        azioniGiorno ? azioniGiorno(g) : null),
      h('td', { 'data-et': 'lavorate' }, g.minutiLavorati ? durata(g.minutiLavorati) : ''),
      h('td', { class: 'tenue', 'data-et': 'previste' }, g.minutiTeorici ? durata(g.minutiTeorici) : ''),
      h('td', {}, g.anomalie.map((a) => h('div', { class: 'avviso' }, ANOMALIE[a.tipo] || a.tipo))));
  });
  return h('div', { class: 'scorri' },
    h('table', { class: 'tabella adatta' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Giorno'), h('th', {}, 'Timbrature'), h('th', {}, 'Lavorate'), h('th', {}, 'Previste'), h('th', {}, 'Da sistemare'))),
      h('tbody', {}, righe)),
    h('p', {}, h('strong', {}, `Totale ${durata(dati.totali.minutiLavorati)}`), h('span', { class: 'tenue' }, ` su ${durata(dati.totali.minutiTeorici)} previste`),
      dati.chiuso ? h('span', { class: 'avviso' }, ' · mese chiuso') : null),
    legenda());
}

function navMese(mese, cambia) {
  return h('div', { class: 'riga', style: 'align-items:center;margin-bottom:8px' },
    h('button', { class: 'piccolo', onclick: () => cambia(spostaMese(mese, -1)) }, '‹'),
    h('strong', { style: 'min-width:140px;text-align:center' }, fmtMese.format(dataG(mese + '-15'))),
    h('button', { class: 'piccolo', onclick: () => cambia(spostaMese(mese, 1)) }, '›'));
}

// ---------- dipendente ----------

async function vistaOggi(el) {
  const u = stato.utente;
  const g = oggi();
  const dati = await api('GET', `/api/me/cartellino?mese=${meseDi(g)}`);
  const giorno = dati.giorni.find((x) => x.giorno === g);
  const err = h('div');
  const timbra = (verso) => async () => {
    try {
      const r = await api('POST', '/api/me/timbra', { verso });
      messaggio(err, `${r.verso === 'uscita' ? 'Uscita' : 'Entrata'} registrata alle ${ora(new Date())}`, 'ok');
      setTimeout(disegna, 1200);
    } catch (e) { messaggio(err, e.message); }
  };
  el.replaceChildren(
    h('div', { class: 'carta' },
      h('h2', {}, fmtGiornoLungo.format(dataG(g))),
      giorno.timbrature.length ? h('div', {}, giorno.timbrature.map((t) => chip(t))) : h('p', { class: 'tenue' }, 'Nessuna timbratura oggi.'),
      h('p', {}, giorno.aperta ? h('span', { class: 'ok' }, 'Sei dentro') : h('span', { class: 'tenue' }, 'Sei fuori'),
        giorno.minutiLavorati ? ` · ${durata(giorno.minutiLavorati)} lavorate` : ''),
      u.remoto_abilitato ? h('div', { class: 'riga' },
        h('button', { class: 'primario', onclick: timbra('entrata') }, 'Timbra entrata'),
        h('button', { onclick: timbra('uscita') }, 'Timbra uscita')) : null,
      err),
    formDimenticata(() => disegna()));
}

function formDimenticata(dopo) {
  const err = h('div');
  const giorno = h('input', { type: 'date', value: oggi(), max: oggi(), required: true });
  const ore = h('input', { type: 'time', required: true });
  const verso = h('select', {}, h('option', { value: 'entrata' }, 'Entrata'), h('option', { value: 'uscita' }, 'Uscita'));
  const motivo = h('input', { type: 'text', placeholder: 'es. dimenticato il badge', required: true, maxlength: 500 });
  return h('div', { class: 'carta' },
    h('h2', {}, 'Ho dimenticato una timbratura'),
    h('p', { class: 'tenue' }, 'Conta subito nelle tue ore, ma resta segnata come «inserita a mano» (✍) e l\'amministrazione la vede.'),
    h('form', {
      class: 'riga',
      onsubmit: async (ev) => {
        ev.preventDefault();
        try {
          await api('POST', '/api/me/timbrature/dimenticata', { giorno: giorno.value, ora: ore.value, verso: verso.value, motivo: motivo.value });
          messaggio(err, 'Timbratura inserita', 'ok');
          ore.value = ''; motivo.value = '';
          if (dopo) setTimeout(dopo, 800);
        } catch (e) { messaggio(err, e.message); }
      },
    }, h('label', {}, 'Giorno', giorno), h('label', {}, 'Ora', ore), h('label', {}, 'Tipo', verso),
    h('label', { style: 'flex:1;min-width:200px' }, 'Motivo', motivo), h('button', { type: 'submit', class: 'primario' }, 'Inserisci')),
    err);
}

async function vistaCartellino(el) {
  const mese = stato.mese || meseDi(oggi());
  const dati = await api('GET', `/api/me/cartellino?mese=${mese}`);
  const err = h('div');
  el.replaceChildren(
    h('div', { class: 'carta' },
      navMese(mese, (m) => { stato.mese = m; disegna(); }),
      err,
      tabellaCartellino(dati, {
        azioniTimbratura: (t) => (t.origine === 'automatica' && t.da_confermare && !t.confermata_il
          ? h('button', {
            class: 'piccolo', title: 'Confermo che sono uscito a quest\'ora',
            onclick: async () => { try { await api('POST', `/api/me/timbrature/${t.id}/conferma`, {}); disegna(); } catch (e) { messaggio(err, e.message); } },
          }, 'Confermo')
          : null),
      }),
      h('p', { class: 'tenue', style: 'font-size:13px' }, 'Se la chiusura automatica ⏱ ha l\'orario sbagliato, inserisci qui sotto la tua uscita vera: prende il suo posto.')),
    formDimenticata(() => disegna()));
}

// ---------- amministrazione ----------

async function vistaDaSistemare(el) {
  const al = new Date(Date.now() - 86400000);
  const dal = new Date(Date.now() - 31 * 86400000);
  const lista = await api('GET', `/api/admin/anomalie?dal=${fmtData.format(dal)}&al=${fmtData.format(al)}`);
  el.replaceChildren(h('div', { class: 'carta' },
    h('h2', {}, 'Da sistemare · ultimi 30 giorni'),
    lista.length ? h('div', { class: 'scorri' }, h('table', { class: 'tabella adatta' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Persona'), h('th', {}, 'Giorno'), h('th', {}, 'Timbrature'), h('th', {}, 'Cosa'), h('th', {}, ''))),
      h('tbody', {}, lista.map((r) => h('tr', {},
        h('td', {}, `${r.persona.cognome} ${r.persona.nome}`),
        h('td', {}, fmtGiorno.format(dataG(r.giorno)), ' ', r.giorno.slice(5, 7) + '/' + r.giorno.slice(0, 4)),
        h('td', {}, r.timbrature.map((t) => chip(t))),
        h('td', {}, r.anomalie.map((a) => h('div', { class: 'avviso' }, ANOMALIE[a.tipo] || a.tipo)),
          r.manuali ? h('div', {}, '✍ timbratura inserita a mano') : null),
        h('td', {}, h('button', {
          class: 'piccolo',
          onclick: () => { stato.persona = r.persona.id; stato.mese = meseDi(r.giorno); stato.scheda = 'cartellinoPersona'; disegna(); },
        }, 'Apri')))))))
      : h('p', { class: 'ok' }, 'Niente da sistemare.'),
    legenda()));
}

async function vistaCartellinoPersona(el) {
  const persone = (await api('GET', '/api/admin/persone')).filter((p) => p.attiva);
  if (!persone.length) return el.replaceChildren(h('p', { class: 'tenue' }, 'Nessuna persona in anagrafica.'));
  if (!persone.some((p) => p.id === stato.persona)) stato.persona = persone[0].id;
  const mese = stato.mese || meseDi(oggi());
  const dati = await api('GET', `/api/admin/cartellino?persona=${stato.persona}&mese=${mese}`);
  const err = h('div');
  const correggi = async (corpo) => { await api('POST', '/api/admin/correzioni', corpo); disegna(); };
  const motivo = { nome: 'motivo', etichetta: 'Motivo', obbligatorio: true };

  const azioniTimbratura = (t, g) => {
    const b = (testo, fn, titolo) => h('button', { class: 'piccolo', title: titolo, onclick: fn }, testo);
    return h('span', {},
      b('✎', () => dialogo(`Sposta la timbratura delle ${ora(t.istante)}`, [
        { nome: 'giorno', etichetta: 'Giorno', tipo: 'date', valore: g.giorno, obbligatorio: true },
        { nome: 'ora', etichetta: 'Ora', tipo: 'time', valore: ora(t.istante), obbligatorio: true }, motivo,
      ], (v) => correggi({ tipo: 'spostamento', timbratura_id: t.id, ...v })), 'Sposta orario'),
      b('⇄', () => dialogo(`Segna come ${t.verso === 'entrata' ? 'uscita' : 'entrata'}`, [motivo],
        (v) => correggi({ tipo: 'verso', timbratura_id: t.id, verso: t.verso === 'entrata' ? 'uscita' : 'entrata', ...v })), 'Inverti entrata/uscita'),
      b('✕', () => dialogo(`Annulla la timbratura delle ${ora(t.istante)}`, [motivo],
        (v) => correggi({ tipo: 'annullamento', timbratura_id: t.id, ...v }), { nota: 'Resterà visibile, barrata.' }), 'Annulla'),
      t.origine === 'automatica' && t.da_confermare && !t.confermata_il
        ? b('✓', () => correggi({ tipo: 'conferma', timbratura_id: t.id }).catch((e) => messaggio(err, e.message)), 'Conferma la chiusura automatica')
        : null);
  };
  const azioniGiorno = (g) => (dati.chiuso ? null : h('button', {
    class: 'piccolo', title: 'Aggiungi una timbratura',
    onclick: () => dialogo(`Aggiungi timbratura · ${fmtGiornoLungo.format(dataG(g.giorno))}`, [
      { nome: 'ora', etichetta: 'Ora', tipo: 'time', obbligatorio: true },
      { nome: 'verso', etichetta: 'Tipo', tipo: 'select', valore: 'entrata', opzioni: [['entrata', 'Entrata'], ['uscita', 'Uscita']] }, motivo,
    ], (v) => correggi({ tipo: 'aggiunta', persona_id: stato.persona, giorno: g.giorno, ...v })),
  }, '+'));

  el.replaceChildren(h('div', { class: 'carta' },
    h('div', { class: 'riga', style: 'margin-bottom:8px' },
      h('label', {}, 'Persona', h('select', { onchange: (ev) => { stato.persona = Number(ev.target.value); disegna(); } },
        persone.map((p) => h('option', { value: p.id, selected: p.id === stato.persona }, `${p.cognome} ${p.nome}`))))),
    navMese(mese, (m) => { stato.mese = m; disegna(); }),
    err,
    tabellaCartellino(dati, { azioniGiorno, azioniTimbratura: dati.chiuso ? null : azioniTimbratura }),
    h('p', { class: 'tenue', style: 'font-size:13px' }, '+ aggiungi · ✎ sposta · ⇄ inverti entrata/uscita · ✕ annulla · ✓ conferma chiusura automatica. Ogni correzione chiede un motivo e resta registrata.')));
}

async function vistaPersone(el) {
  const [persone, profili] = await Promise.all([api('GET', '/api/admin/persone'), api('GET', '/api/admin/profili')]);
  const err = h('div');
  const nuova = { nome: h('input', { required: true }), cognome: h('input', { required: true }), email: h('input', { type: 'email' }) };
  const ricarica = () => disegna();
  const azione = (fn) => async (...a) => { try { await fn(...a); } catch (e) { messaggio(err, e.message); } };

  const dettaglio = (p) => {
    const box = h('div', { class: 'pila', style: 'padding:8px 0' });
    const campi = {
      nome: h('input', { value: p.nome }), cognome: h('input', { value: p.cognome }), email: h('input', { type: 'email', value: p.email || '' }),
      remoto: h('input', { type: 'checkbox', checked: p.remoto_abilitato }), attiva: h('input', { type: 'checkbox', checked: p.attiva }),
    };
    const ruoli = ['dipendente', 'responsabile', 'hr', 'admin'].map((r) => [r, h('input', { type: 'checkbox', checked: p.ruoli.includes(r) })]);
    const badge = h('input', { placeholder: 'passa il badge sul lettore o scrivi il codice' });
    const badgeDal = h('input', { type: 'date', value: oggi() });
    const profilo = h('select', {}, profili.map((x) => h('option', { value: x.id, selected: p.profilo && p.profilo.id === x.id }, x.nome)));
    const profiloDal = h('input', { type: 'date', value: oggi() });
    const link = h('div');
    box.append(
      h('div', { class: 'riga' },
        h('label', {}, 'Nome', campi.nome), h('label', {}, 'Cognome', campi.cognome), h('label', {}, 'Email', campi.email)),
      h('div', { class: 'riga' },
        ruoli.map(([r, c]) => h('label', { style: 'flex-direction:row;align-items:center' }, c, r)),
        h('label', { style: 'flex-direction:row;align-items:center' }, campi.remoto, 'può timbrare da remoto'),
        h('label', { style: 'flex-direction:row;align-items:center' }, campi.attiva, 'attiva'),
        h('button', {
          class: 'primario',
          onclick: azione(async () => {
            const corpo = {
              nome: campi.nome.value, cognome: campi.cognome.value, email: campi.email.value,
              remoto_abilitato: campi.remoto.checked, attiva: campi.attiva.checked,
            };
            const nuoviRuoli = ruoli.filter(([, c]) => c.checked).map(([r]) => r);
            if (nuoviRuoli.join() !== p.ruoli.join()) corpo.ruoli = nuoviRuoli;
            await api('PATCH', `/api/admin/persone/${p.id}`, corpo);
            ricarica();
          }),
        }, 'Salva')),
      h('div', { class: 'riga' },
        h('label', { style: 'flex:1' }, 'Badge', badge), h('label', {}, 'Valido dal', badgeDal),
        h('button', { onclick: azione(async () => { await api('POST', `/api/admin/persone/${p.id}/badge`, { codice: badge.value, dal: badgeDal.value }); ricarica(); }) }, 'Assegna badge'),
        p.badge.map((b) => h('button', {
          class: 'piccolo', title: 'Revoca questo badge',
          onclick: azione(async () => { if (confirm(`Revocare il badge ${b.codice}?`)) { await api('DELETE', `/api/admin/badge/${b.id}`, {}); ricarica(); } }),
        }, `revoca ${b.codice}`))),
      h('div', { class: 'riga' },
        h('label', {}, 'Profilo orario', profilo), h('label', {}, 'Dal', profiloDal),
        h('button', { disabled: !profili.length, onclick: azione(async () => { await api('POST', `/api/admin/persone/${p.id}/profilo`, { profilo_id: Number(profilo.value), dal: profiloDal.value }); ricarica(); }) }, 'Assegna profilo')),
      h('div', { class: 'riga' },
        h('button', {
          onclick: azione(async () => {
            const r = await api('POST', `/api/admin/persone/${p.id}/attivazione`, {});
            link.replaceChildren(h('p', { class: 'tenue' }, 'Manda questo link alla persona (vale 7 giorni, una sola volta):'), h('code', { class: 'copia' }, r.link));
          }),
        }, p.accessi.some((a) => a.provider === 'locale' && a.password_impostata) ? 'Link per reimpostare la password' : 'Link per creare la password')),
      link);
    return box;
  };

  el.replaceChildren(
    h('div', { class: 'carta' },
      h('h2', {}, 'Nuova persona'),
      h('form', {
        class: 'riga',
        onsubmit: azione(async (ev) => {
          ev.preventDefault();
          await api('POST', '/api/admin/persone', { nome: nuova.nome.value, cognome: nuova.cognome.value, email: nuova.email.value });
          ricarica();
        }),
      }, h('label', {}, 'Nome', nuova.nome), h('label', {}, 'Cognome', nuova.cognome), h('label', {}, 'Email (per Microsoft/Google o password)', nuova.email),
      h('button', { type: 'submit', class: 'primario' }, 'Aggiungi')),
      err),
    h('div', { class: 'carta' },
      h('h2', {}, `Persone (${persone.length})`),
      h('div', { class: 'scorri' }, h('table', { class: 'tabella adatta' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Persona'), h('th', {}, 'Badge'), h('th', {}, 'Orario'), h('th', {}, 'Accesso'), h('th', {}, ''))),
        h('tbody', {}, persone.flatMap((p) => {
          const det = h('tr', { hidden: true }, h('td', { colspan: 5 }, dettaglio(p)));
          return [h('tr', { style: p.attiva ? '' : 'opacity:.55' },
            h('td', {}, h('strong', {}, `${p.cognome} ${p.nome}`), h('div', { class: 'tenue' }, p.email || 'senza email'),
              h('div', { class: 'tenue', style: 'font-size:12px' }, p.ruoli.join(', '), p.remoto_abilitato ? ' · remoto' : '', p.attiva ? '' : ' · disattivata')),
            h('td', {}, p.badge.map((b) => b.codice).join(', ') || h('span', { class: 'avviso' }, 'nessuno')),
            h('td', {}, p.profilo ? p.profilo.nome : h('span', { class: 'avviso' }, 'nessuno')),
            h('td', { class: 'tenue' }, p.accessi.map((a) => (a.provider === 'locale' ? (a.password_impostata ? 'password' : 'password da creare') : a.provider)).join(', ') || '—'),
            h('td', {}, h('button', { class: 'piccolo', onclick: () => { det.hidden = !det.hidden; } }, 'Modifica'))), det];
        }))))));
}

async function vistaPresenti(el) {
  const lista = await api('GET', '/api/admin/presenti');
  el.replaceChildren(h('div', { class: 'carta' },
    h('h2', {}, `Presenti adesso: ${lista.length}`),
    lista.length ? h('ul', {}, lista.map((x) => h('li', {}, `${x.persona.cognome} ${x.persona.nome}`, h('span', { class: 'tenue' }, ` · dentro dalle ${ora(x.dal)}`))))
      : h('p', { class: 'tenue' }, 'Nessuno risulta dentro.'),
    h('button', { onclick: () => disegna() }, 'Aggiorna')));
}

const ESEMPIO_REGOLE = {
  1: [{ da: '08:30', a: '12:30' }, { da: '13:30', a: '17:30' }],
  2: [{ da: '08:30', a: '12:30' }, { da: '13:30', a: '17:30' }],
  3: [{ da: '08:30', a: '12:30' }, { da: '13:30', a: '17:30' }],
  4: [{ da: '08:30', a: '12:30' }, { da: '13:30', a: '17:30' }],
  5: [{ da: '08:30', a: '12:30' }, { da: '13:30', a: '17:30' }],
  6: [], 7: [],
};

async function vistaImpostazioni(el) {
  const [profili, dispositivi, festivita] = await Promise.all([
    api('GET', '/api/admin/profili'), api('GET', '/api/admin/dispositivi'), api('GET', '/api/admin/festivita')]);
  const err = h('div');
  const azione = (fn) => async (...a) => { try { await fn(...a); } catch (e) { messaggio(err, e.message); } };

  const editorProfilo = (p) => {
    const nome = h('input', { value: p ? p.nome : '', required: true });
    const toll = h('input', { type: 'number', min: 0, max: 720, value: p ? p.tolleranza_notte_min : 120, style: 'width:90px' });
    const regole = h('textarea', { rows: 9, style: 'width:100%;font-family:ui-monospace,monospace;font-size:13px' });
    regole.value = JSON.stringify(p ? p.regole : ESEMPIO_REGOLE, null, 1);
    return h('div', { class: 'pila', style: 'border-top:1px solid var(--bordo);padding-top:10px;margin-top:10px' },
      h('div', { class: 'riga' }, h('label', {}, 'Nome', nome), h('label', {}, 'Tolleranza turni notte (min)', toll),
        h('button', {
          class: 'primario',
          onclick: azione(async () => {
            let r;
            try { r = JSON.parse(regole.value); } catch (_) { throw new Error('Regole: JSON non valido'); }
            const corpo = { nome: nome.value, regole: r, tolleranza_notte_min: Number(toll.value) };
            await api(p ? 'PUT' : 'POST', p ? `/api/admin/profili/${p.id}` : '/api/admin/profili', corpo);
            disegna();
          }),
        }, p ? 'Salva' : 'Crea profilo')),
      regole);
  };

  const nomeDisp = h('input', { placeholder: 'es. Ingresso principale', required: true });
  const tokenBox = h('div');
  const meseInput = h('input', { type: 'month', value: spostaMese(meseDi(oggi()), -1) });
  const festData = h('input', { type: 'date', required: true });
  const festNome = h('input', { placeholder: 'es. Santo patrono', required: true });

  el.replaceChildren(
    err,
    h('div', { class: 'carta' },
      h('h2', {}, 'Profili orario'),
      h('p', { class: 'tenue', style: 'font-size:13px' }, 'Giorni: 1 = lunedì … 7 = domenica. Ogni fascia ha "da" e "a" (HH:MM); una fascia che finisce prima di iniziare va al giorno dopo (turno di notte). La chiusura automatica usa la fine dell\'ultima fascia.'),
      profili.map(editorProfilo), h('h2', { style: 'margin-top:16px' }, 'Nuovo profilo'), editorProfilo(null)),
    h('div', { class: 'carta' },
      h('h2', {}, 'Terminali'),
      dispositivi.length ? h('ul', {}, dispositivi.map((d) => h('li', {},
        `${d.nome} `, h('span', { class: 'tenue' }, d.ultimo_contatto ? `· ultimo contatto ${new Date(d.ultimo_contatto).toLocaleString('it-IT')}` : '· mai collegato'),
        ' ', h('button', { class: 'piccolo', onclick: azione(async () => { await api('PATCH', `/api/admin/dispositivi/${d.id}`, { attivo: !d.attivo }); disegna(); }) }, d.attivo ? 'Disattiva' : 'Riattiva'))))
        : h('p', { class: 'tenue' }, 'Nessun terminale.'),
      h('form', {
        class: 'riga',
        onsubmit: azione(async (ev) => {
          ev.preventDefault();
          const r = await api('POST', '/api/admin/dispositivi', { nome: nomeDisp.value });
          tokenBox.replaceChildren(
            h('p', {}, 'Sul Raspberry apri ', h('code', {}, `${location.origin}/kiosk`), ' e incolla questo codice. Si vede solo adesso:'),
            h('code', { class: 'copia' }, r.token));
        }),
      }, h('label', {}, 'Nome', nomeDisp), h('button', { type: 'submit' }, 'Aggiungi terminale')),
      tokenBox),
    h('div', { class: 'carta' },
      h('h2', {}, 'Chiusura del mese'),
      h('p', { class: 'tenue', style: 'font-size:13px' }, 'Un mese chiuso non accetta più correzioni né timbrature inserite a mano, finché non lo riapri.'),
      h('div', { class: 'riga' }, h('label', {}, 'Mese', meseInput),
        h('button', { onclick: azione(async () => { await api('POST', `/api/admin/mesi/${meseInput.value}/chiudi`, {}); messaggio(err, `Mese ${meseInput.value} chiuso`, 'ok'); }) }, 'Chiudi'),
        h('button', { onclick: azione(async () => { await api('POST', `/api/admin/mesi/${meseInput.value}/riapri`, {}); messaggio(err, `Mese ${meseInput.value} riaperto`, 'ok'); }) }, 'Riapri'))),
    h('div', { class: 'carta' },
      h('h2', {}, 'Festività aziendali'),
      h('p', { class: 'tenue', style: 'font-size:13px' }, 'Le festività nazionali sono già incluse. Qui il patrono e le chiusure aziendali.'),
      festivita.length ? h('ul', {}, festivita.map((f) => h('li', {}, `${f.data} · ${f.nome} `,
        h('button', { class: 'piccolo', onclick: azione(async () => { await api('DELETE', `/api/admin/festivita/${f.data}`, {}); disegna(); }) }, 'rimuovi')))) : null,
      h('form', {
        class: 'riga',
        onsubmit: azione(async (ev) => { ev.preventDefault(); await api('POST', '/api/admin/festivita', { data: festData.value, nome: festNome.value }); disegna(); }),
      }, h('label', {}, 'Data', festData), h('label', {}, 'Nome', festNome), h('button', { type: 'submit' }, 'Aggiungi'))));
}

avvio();
