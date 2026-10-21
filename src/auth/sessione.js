'use strict';
// Sessione in un cookie firmato (HMAC): { p: persona_id, v: sessione_versione, e: scadenza }.
// Aumentare persona.sessione_versione chiude tutte le sessioni di quella persona.

const crypto = require('crypto');

const NOME = 'tb_sess';
const DURATA_MS = 30 * 86400000;

function firma(dati, segreto) {
  return crypto.createHmac('sha256', segreto).update(dati).digest('base64url');
}

function creaValore(personaId, versione, segreto, ora = Date.now()) {
  const dati = Buffer.from(JSON.stringify({ p: personaId, v: versione, e: ora + DURATA_MS })).toString('base64url');
  return `${dati}.${firma(dati, segreto)}`;
}

function leggiValore(valore, segreto, ora = Date.now()) {
  const [dati, f] = String(valore || '').split('.');
  if (!dati || !f) return null;
  const atteso = firma(dati, segreto);
  if (f.length !== atteso.length || !crypto.timingSafeEqual(Buffer.from(f), Buffer.from(atteso))) return null;
  try {
    const s = JSON.parse(Buffer.from(dati, 'base64url').toString('utf8'));
    if (!s || typeof s.p !== 'number' || s.e < ora) return null;
    return s;
  } catch (_) {
    return null;
  }
}

function leggiCookie(req, nome = NOME) {
  const h = req.headers.cookie || '';
  for (const parte of h.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

function intestazioneCookie(valore, { sicuro }) {
  const attr = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (sicuro) attr.push('Secure');
  if (valore === null) return `${NOME}=; ${attr.join('; ')}; Max-Age=0`;
  return `${NOME}=${encodeURIComponent(valore)}; ${attr.join('; ')}; Max-Age=${Math.floor(DURATA_MS / 1000)}`;
}

module.exports = { NOME, creaValore, leggiValore, leggiCookie, intestazioneCookie };
