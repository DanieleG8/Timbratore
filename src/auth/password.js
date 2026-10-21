'use strict';
// Password con scrypt (incluso in Node, nessuna dipendenza esterna).
// Formato salvato: scrypt$N$r$p$sale$hash (base64url)

const crypto = require('crypto');

const N = 16384, R = 8, P = 1, LUN = 64;

function scrypt(password, sale, n, r, p) {
  return new Promise((ok, ko) => crypto.scrypt(password, sale, LUN, { N: n, r, p, maxmem: 64 * 1024 * 1024 },
    (e, k) => (e ? ko(e) : ok(k))));
}

async function hashPassword(password) {
  const sale = crypto.randomBytes(16);
  const k = await scrypt(password, sale, N, R, P);
  return ['scrypt', N, R, P, sale.toString('base64url'), k.toString('base64url')].join('$');
}

async function verificaPassword(password, salvato) {
  const parti = String(salvato || '').split('$');
  if (parti.length !== 6 || parti[0] !== 'scrypt') return false;
  const [, n, r, p, sale, hash] = parti;
  const atteso = Buffer.from(hash, 'base64url');
  const k = await scrypt(String(password), Buffer.from(sale, 'base64url'), Number(n), Number(r), Number(p));
  return k.length === atteso.length && crypto.timingSafeEqual(k, atteso);
}

function problemaPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'La password deve avere almeno 10 caratteri';
  if (pw.length > 200) return 'Password troppo lunga';
  return null;
}

module.exports = { hashPassword, verificaPassword, problemaPassword };
