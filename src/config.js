'use strict';
// Configurazione dalle variabili d'ambiente (su Railway: Variables).
// Elenco completo in .env.example e in docs/requisiti.md §3.1.

const crypto = require('crypto');

function leggiConfig(env = process.env) {
  const produzione = env.NODE_ENV === 'production' || !!env.RAILWAY_ENVIRONMENT;
  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    if (produzione) throw new Error('SESSION_SECRET mancante: impostala nelle variabili di Railway');
    sessionSecret = crypto.randomBytes(32).toString('hex'); // in locale le sessioni durano fino al riavvio
  }
  let databaseUrl = env.DATABASE_URL || '';
  if (!databaseUrl) {
    if (produzione) throw new Error('DATABASE_URL mancante: aggiungi il database PostgreSQL al progetto Railway');
    databaseUrl = 'pglite:./.dati-locali';
  }
  return {
    produzione,
    porta: Number(env.PORT) || 3000,
    databaseUrl,
    sessionSecret,
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    entra: env.ENTRA_TENANT_ID && env.ENTRA_CLIENT_ID ? { tenant: env.ENTRA_TENANT_ID, clientId: env.ENTRA_CLIENT_ID } : null,
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_HD ? { clientId: env.GOOGLE_CLIENT_ID, hd: env.GOOGLE_HD } : null,
    adminEmail: env.ADMIN_EMAIL || '',
    adminPassword: env.ADMIN_PASSWORD || '',
    chiusuraIntervalloMin: Number(env.CHIUSURA_INTERVALLO_MIN) || 5,
  };
}

module.exports = { leggiConfig };
