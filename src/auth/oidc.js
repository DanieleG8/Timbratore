'use strict';
// Verifica degli ID token Microsoft (Entra ID) e Google Workspace.
// Stesso schema di orderEntry: firma RS256 sulle chiavi pubbliche del
// provider, poi controllo di emittente, destinatario, tenant o dominio.

const crypto = require('crypto');

const SFASAMENTO_S = 300;

function creaCacheChiavi(fetchFn = fetch) {
  const cache = new Map(); // url -> { chiavi, ts }
  return async function chiave(url, kid) {
    let c = cache.get(url);
    const trova = () => c && c.chiavi.find((k) => k.kid === kid);
    if (!trova() || Date.now() - c.ts > 3600000) {
      const r = await fetchFn(url);
      if (!r.ok) throw new Error('chiavi del provider non disponibili');
      const j = await r.json();
      c = { chiavi: (j && j.keys) || [], ts: Date.now() };
      cache.set(url, c);
    }
    const k = trova();
    if (!k) throw new Error('chiave di firma sconosciuta');
    return crypto.createPublicKey({ key: k, format: 'jwk' });
  };
}

function decodifica(token) {
  const parti = String(token || '').split('.');
  if (parti.length !== 3) throw new Error('token non valido');
  const [h, p, s] = parti;
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
    firmato: `${h}.${p}`,
    firma: Buffer.from(s, 'base64url'),
  };
}

async function verificaFirma(token, jwksUrl, chiave) {
  const t = decodifica(token);
  if (t.header.alg !== 'RS256') throw new Error('algoritmo non ammesso');
  const pub = await chiave(jwksUrl, t.header.kid);
  if (!crypto.verify('RSA-SHA256', Buffer.from(t.firmato), pub, t.firma)) throw new Error('firma non valida');
  const ora = Math.floor(Date.now() / 1000);
  const p = t.payload;
  if (typeof p.exp !== 'number' || p.exp + SFASAMENTO_S < ora) throw new Error('token scaduto');
  if (typeof p.nbf === 'number' && p.nbf - SFASAMENTO_S > ora) throw new Error('token non ancora valido');
  return p;
}

function creaVerificatore({ entra, google, fetchFn } = {}) {
  const chiave = creaCacheChiavi(fetchFn);
  return {
    async microsoft(token) {
      if (!entra) throw new Error('accesso Microsoft non configurato');
      const p = await verificaFirma(token, `https://login.microsoftonline.com/${entra.tenant}/discovery/v2.0/keys`, chiave);
      if (p.aud !== entra.clientId) throw new Error('destinatario non valido');
      if (p.tid !== entra.tenant) throw new Error('tenant non valido');
      if (p.iss !== `https://login.microsoftonline.com/${entra.tenant}/v2.0`) throw new Error('emittente non valido');
      if (!p.oid) throw new Error('utente non identificato');
      return { idEsterno: p.oid, email: p.email || p.preferred_username || null, nome: p.name || null };
    },
    async google(token) {
      if (!google) throw new Error('accesso Google non configurato');
      const p = await verificaFirma(token, 'https://www.googleapis.com/oauth2/v3/certs', chiave);
      if (p.aud !== google.clientId) throw new Error('destinatario non valido');
      if (p.iss !== 'https://accounts.google.com' && p.iss !== 'accounts.google.com') throw new Error('emittente non valido');
      // solo account del Workspace aziendale: il controllo vale qui, non nella pagina
      if (p.hd !== google.hd) throw new Error('account non del dominio aziendale');
      if (p.email_verified !== true) throw new Error('email non verificata');
      return { idEsterno: p.sub, email: p.email, nome: p.name || null };
    },
  };
}

module.exports = { creaVerificatore };
