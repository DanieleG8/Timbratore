'use strict';
// Server HTTP: API JSON + file statici della web app e del terminale.
// Nessun framework: poche rotte, dichiarate in tabella.

const fs = require('fs');
const path = require('path');
const { ErroreApi, richiesta, vietato } = require('./errori');
const sessione = require('./auth/sessione');
const { creaVerificatore } = require('./auth/oidc');
const accessi = require('./services/accessi');
const anagrafica = require('./services/anagrafica');
const T = require('./services/timbrature');
const correzioni = require('./services/correzioni');
const { riceviDaKiosk } = require('./services/kiosk');
const riepiloghi = require('./services/riepiloghi');
const { giornoDi, giornoValido, RE_MESE, aggiungiGiorni } = require('./core/tempo');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
};
const PAGINE = { '/': 'index.html', '/kiosk': 'kiosk.html' };

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "frame-src https://accounts.google.com/gsi/",
  "connect-src 'self' https://login.microsoftonline.com https://accounts.google.com/gsi/",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Limite ai tentativi di login falliti, per IP (in memoria: basta un'istanza).
function creaLimitatore(max = 10, finestraMs = 15 * 60000) {
  const m = new Map();
  return {
    bloccato(chiave) {
      const x = m.get(chiave);
      if (!x || Date.now() - x.da > finestraMs) return false;
      return x.n >= max;
    },
    fallito(chiave) {
      const x = m.get(chiave);
      if (!x || Date.now() - x.da > finestraMs) m.set(chiave, { n: 1, da: Date.now() });
      else x.n++;
    },
    ok(chiave) { m.delete(chiave); },
  };
}

function leggiCorpo(req, limite = 256 * 1024) {
  return new Promise((ok, ko) => {
    let n = 0;
    const parti = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limite) { ko(new ErroreApi(413, 'Richiesta troppo grande')); req.destroy(); return; }
      parti.push(c);
    });
    req.on('end', () => {
      if (!n) return ok({});
      try { ok(JSON.parse(Buffer.concat(parti).toString('utf8'))); } catch (_) { ko(richiesta('JSON non valido')); }
    });
    req.on('error', ko);
  });
}

function json(res, status, dati, intestazioni = {}) {
  const corpo = JSON.stringify(dati);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...intestazioni });
  res.end(corpo);
}

function creaApp({ db, config, verificatore, log = console, ora = () => new Date() }) {
  verificatore = verificatore || creaVerificatore({ entra: config.entra, google: config.google });
  const limitatore = creaLimitatore();
  const sicuro = config.produzione;

  async function utenteDa(req) {
    const s = sessione.leggiValore(sessione.leggiCookie(req), config.sessionSecret);
    if (!s) return null;
    const r = await db.query(
      `SELECT id, nome, cognome, email, ruoli, remoto_abilitato, sessione_versione FROM persona WHERE id = $1 AND attiva`, [s.p]);
    if (!r.length || r[0].sessione_versione !== s.v) return null;
    return r[0];
  }

  async function apriSessione(res, personaId) {
    const r = await db.query('SELECT sessione_versione FROM persona WHERE id = $1', [personaId]);
    return { 'Set-Cookie': sessione.intestazioneCookie(sessione.creaValore(personaId, r[0].sessione_versione, config.sessionSecret), { sicuro }) };
  }

  const eAdmin = (u) => u.ruoli.includes('admin') || u.ruoli.includes('hr');
  // dietro il proxy di Railway: l'ultimo indirizzo è quello aggiunto dal proxy, i primi li può scrivere chiunque
  const ip = (req) => String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',').pop() || req.socket.remoteAddress || '').trim();
  const meseCorrente = () => giornoDi(ora()).slice(0, 7);
  const mese = (v) => {
    const m = v || meseCorrente();
    if (!RE_MESE.test(m)) throw richiesta('Mese non valido (AAAA-MM)');
    return m;
  };

  // [metodo, percorso, accesso, gestore]  accesso: 'pubblico' | 'utente' | 'admin' | 'kiosk'
  const rotte = [
    ['GET', '/health', 'pubblico', async () => {
      await db.query('SELECT 1');
      return { ok: true };
    }],

    // --- accesso ---
    ['GET', '/api/auth/config', 'pubblico', async () => ({
      microsoft: config.entra ? { clientId: config.entra.clientId, tenant: config.entra.tenant } : null,
      google: config.google ? { clientId: config.google.clientId, hd: config.google.hd } : null,
    })],
    ['POST', '/api/auth/login', 'pubblico', async ({ req, corpo }) => {
      const chiave = ip(req);
      if (limitatore.bloccato(chiave)) throw new ErroreApi(429, 'Troppi tentativi: riprova fra qualche minuto');
      try {
        const id = await accessi.loginLocale(db, corpo.email, corpo.password);
        limitatore.ok(chiave);
        return { _intestazioni: await apriSessione(null, id), ok: true };
      } catch (e) {
        if (e.status === 401) limitatore.fallito(chiave);
        throw e;
      }
    }],
    ['POST', '/api/auth/oidc', 'pubblico', async ({ req, corpo }) => {
      const chiave = ip(req);
      if (limitatore.bloccato(chiave)) throw new ErroreApi(429, 'Troppi tentativi: riprova fra qualche minuto');
      const provider = corpo.provider;
      if (provider !== 'microsoft' && provider !== 'google') throw richiesta('Provider non valido');
      let dati;
      try {
        dati = await verificatore[provider](corpo.id_token);
      } catch (e) {
        limitatore.fallito(chiave);
        log.warn(`[auth] ${provider} rifiutato: ${e.message}`);
        throw new ErroreApi(401, 'Accesso non riuscito');
      }
      const id = await accessi.loginEsterno(db, provider, dati);
      limitatore.ok(chiave);
      return { _intestazioni: await apriSessione(null, id), ok: true };
    }],
    ['POST', '/api/auth/attiva', 'pubblico', async ({ corpo }) => {
      const id = await accessi.attiva(db, corpo.token, corpo.password);
      return { _intestazioni: await apriSessione(null, id), ok: true };
    }],
    ['POST', '/api/auth/logout', 'pubblico', async () => ({
      _intestazioni: { 'Set-Cookie': sessione.intestazioneCookie(null, { sicuro }) }, ok: true,
    })],

    // --- dipendente ---
    ['GET', '/api/me', 'utente', async ({ utente }) => {
      const { sessione_versione, ...u } = utente;
      return { ...u, admin: eAdmin(utente) };
    }],
    ['GET', '/api/me/cartellino', 'utente', async ({ utente, query }) =>
      T.cartellino(db, utente.id, mese(query.get('mese')), ora())],
    ['POST', '/api/me/timbra', 'utente', async ({ utente, corpo }) => {
      if (!utente.remoto_abilitato) throw vietato('La timbratura da remoto non è abilitata per te');
      const verso = corpo.verso === 'entrata' || corpo.verso === 'uscita' ? corpo.verso : 'auto';
      let posizione = null;
      if (corpo.posizione && Number.isFinite(corpo.posizione.lat) && Number.isFinite(corpo.posizione.lon)) {
        posizione = { lat: corpo.posizione.lat, lon: corpo.posizione.lon, precisione: Number(corpo.posizione.precisione) || null };
      }
      return db.tx((q) => T.registra(q, { persona_id: utente.id, istante: ora(), verso_dichiarato: verso, origine: 'web', posizione }));
    }],
    ['POST', '/api/me/timbrature/dimenticata', 'utente', async ({ utente, corpo }) =>
      correzioni.timbraturaDimenticata(db, utente, corpo, ora())],
    ['POST', '/api/me/timbrature/:id/conferma', 'utente', async ({ utente, param }) =>
      correzioni.confermaPropria(db, utente, param.id)],

    // --- terminale ---
    ['GET', '/api/kiosk/ping', 'kiosk', async ({ dispositivo }) => ({ ok: true, nome: dispositivo.nome, ora: ora() })],
    ['POST', '/api/kiosk/timbrature', 'kiosk', async ({ dispositivo, corpo }) =>
      ({ esiti: await riceviDaKiosk(db, dispositivo, corpo.timbrature, ora()) })],

    // --- amministrazione ---
    ['GET', '/api/admin/persone', 'admin', async () => anagrafica.elencoPersone(db)],
    ['POST', '/api/admin/persone', 'admin', async ({ corpo, utente }) => {
      if (Array.isArray(corpo.ruoli) && corpo.ruoli.some((r) => r === 'admin' || r === 'hr') && !utente.ruoli.includes('admin')) {
        throw vietato('Solo un amministratore può assegnare i ruoli admin e hr');
      }
      return anagrafica.creaPersona(db, corpo);
    }],
    ['PATCH', '/api/admin/persone/:id', 'admin', async ({ param, corpo, utente }) => {
      if (corpo.ruoli !== undefined && !utente.ruoli.includes('admin')) throw vietato('Solo un amministratore può cambiare i ruoli');
      return anagrafica.aggiornaPersona(db, Number(param.id), corpo);
    }],
    ['POST', '/api/admin/persone/:id/badge', 'admin', async ({ param, corpo }) => anagrafica.assegnaBadge(db, Number(param.id), corpo)],
    ['DELETE', '/api/admin/badge/:id', 'admin', async ({ param }) => anagrafica.revocaBadge(db, Number(param.id))],
    ['POST', '/api/admin/persone/:id/profilo', 'admin', async ({ param, corpo }) => anagrafica.assegnaProfilo(db, Number(param.id), corpo)],
    ['POST', '/api/admin/persone/:id/attivazione', 'admin', async ({ param, req }) => {
      const id = Number(param.id);
      if (!(await db.query('SELECT 1 FROM persona WHERE id = $1 AND attiva', [id])).length) throw richiesta('Persona non trovata o non attiva');
      const token = await accessi.creaAttivazione(db, id);
      const base = config.publicBaseUrl || `${sicuro ? 'https' : 'http'}://${req.headers.host}`;
      return { link: `${base}/#attiva=${token}`, scade_tra_giorni: 7 };
    }],
    ['GET', '/api/admin/cartellino', 'admin', async ({ query }) => {
      const id = Number(query.get('persona'));
      if (!id) throw richiesta('Indica la persona');
      return T.cartellino(db, id, mese(query.get('mese')), ora());
    }],
    ['POST', '/api/admin/correzioni', 'admin', async ({ utente, corpo }) => correzioni.correggi(db, utente, corpo)],
    ['GET', '/api/admin/anomalie', 'admin', async ({ query }) => {
      const al = query.get('al') || aggiungiGiorni(giornoDi(ora()), -1);
      const dal = query.get('dal') || aggiungiGiorni(al, -30);
      if (!giornoValido(dal) || !giornoValido(al) || dal > al) throw richiesta('Intervallo non valido');
      if (aggiungiGiorni(dal, 92) < al) throw richiesta('Intervallo troppo lungo (massimo 3 mesi)');
      return riepiloghi.anomalie(db, dal, al, ora());
    }],
    ['GET', '/api/admin/presenti', 'admin', async () => riepiloghi.presenti(db, ora())],
    ['GET', '/api/admin/profili', 'admin', async () => anagrafica.elencoProfili(db)],
    ['POST', '/api/admin/profili', 'admin', async ({ corpo }) => anagrafica.salvaProfilo(db, null, corpo)],
    ['PUT', '/api/admin/profili/:id', 'admin', async ({ param, corpo }) => anagrafica.salvaProfilo(db, Number(param.id), corpo)],
    ['GET', '/api/admin/dispositivi', 'admin', async () => anagrafica.elencoDispositivi(db)],
    ['POST', '/api/admin/dispositivi', 'admin', async ({ corpo }) => anagrafica.creaDispositivo(db, corpo)],
    ['PATCH', '/api/admin/dispositivi/:id', 'admin', async ({ param, corpo }) => anagrafica.impostaDispositivo(db, Number(param.id), corpo)],
    ['POST', '/api/admin/mesi/:mese/chiudi', 'admin', async ({ param, utente }) => anagrafica.chiudiMese(db, param.mese, utente.id)],
    ['POST', '/api/admin/mesi/:mese/riapri', 'admin', async ({ param }) => anagrafica.riapriMese(db, param.mese)],
    ['GET', '/api/admin/festivita', 'admin', async () => anagrafica.elencoFestivita(db)],
    ['POST', '/api/admin/festivita', 'admin', async ({ corpo }) => anagrafica.aggiungiFestivita(db, corpo)],
    ['DELETE', '/api/admin/festivita/:data', 'admin', async ({ param }) => anagrafica.rimuoviFestivita(db, param.data)],
  ].map(([metodo, percorso, accesso, gestore]) => {
    const nomi = [];
    const re = new RegExp('^' + percorso.replace(/:(\w+)/g, (_, n) => { nomi.push(n); return '([^/]+)'; }) + '$');
    return { metodo, re, nomi, accesso, gestore };
  });

  async function gestisciApi(req, res, url) {
    const candidate = rotte.filter((r) => r.re.test(url.pathname));
    if (!candidate.length) return json(res, 404, { errore: 'Non trovato' });
    const rotta = candidate.find((r) => r.metodo === req.method);
    if (!rotta) return json(res, 405, { errore: 'Metodo non consentito' });

    const ctx = { req, query: url.searchParams, param: {}, corpo: {} };
    const m = url.pathname.match(rotta.re);
    rotta.nomi.forEach((n, i) => { ctx.param[n] = decodeURIComponent(m[i + 1]); });

    if (req.method !== 'GET') {
      // solo JSON: un form di un altro sito non può arrivare qui (difesa CSRF insieme a SameSite)
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        throw new ErroreApi(415, 'Serve Content-Type: application/json');
      }
      ctx.corpo = await leggiCorpo(req);
      if (!ctx.corpo || typeof ctx.corpo !== 'object' || Array.isArray(ctx.corpo)) throw richiesta('Serve un oggetto JSON');
    }

    if (rotta.accesso === 'kiosk') {
      const h = String(req.headers.authorization || '');
      ctx.dispositivo = await anagrafica.dispositivoDaToken(db, h.startsWith('Bearer ') ? h.slice(7) : '');
      if (!ctx.dispositivo) throw new ErroreApi(401, 'Terminale non autorizzato');
    } else if (rotta.accesso !== 'pubblico') {
      ctx.utente = await utenteDa(req);
      if (!ctx.utente) throw new ErroreApi(401, 'Accesso richiesto');
      if (rotta.accesso === 'admin' && !eAdmin(ctx.utente)) throw vietato();
    }

    const r = await rotta.gestore(ctx);
    const intestazioni = (r && r._intestazioni) || {};
    if (r && r._intestazioni) delete r._intestazioni;
    json(res, 200, r === undefined ? { ok: true } : r, intestazioni);
  }

  function serviStatico(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { errore: 'Metodo non consentito' });
    const nome = PAGINE[url.pathname] || url.pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, nome));
    if (!file.startsWith(PUBLIC + path.sep)) return json(res, 404, { errore: 'Non trovato' });
    fs.readFile(file, (e, dati) => {
      if (e) return json(res, 404, { errore: 'Non trovato' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
      });
      res.end(req.method === 'HEAD' ? undefined : dati);
    });
  }

  return async function gestore(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    if (sicuro) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (_) { return json(res, 400, { errore: 'Indirizzo non valido' }); }
    try {
      if (url.pathname === '/health' || url.pathname.startsWith('/api/')) await gestisciApi(req, res, url);
      else serviStatico(req, res, url);
    } catch (e) {
      if (e instanceof ErroreApi) return json(res, e.status, { errore: e.message, codice: e.codice });
      log.error('[http] errore', req.method, url.pathname, e);
      json(res, 500, { errore: 'Errore interno' });
    }
  };
}

module.exports = { creaApp };
