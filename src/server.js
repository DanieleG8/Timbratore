'use strict';
// Avvio: configurazione, database (con migrazioni), primo amministratore,
// chiusura automatica notturna, server HTTP.

const http = require('http');
const { leggiConfig } = require('./config');
const { apriDb, migra } = require('./db');
const { creaApp } = require('./app');
const { assicuraAmministratore } = require('./services/accessi');
const { avviaChiusure } = require('./services/chiusuraNotturna');

async function avvia() {
  const config = leggiConfig();
  const db = await apriDb(config.databaseUrl);
  await migra(db);
  const admin = await assicuraAmministratore(db, config.adminEmail, config.adminPassword);
  if (admin) console.info(`[avvio] creato l'amministratore ${config.adminEmail}`);
  const fermaChiusure = avviaChiusure(db, { intervalloMin: config.chiusuraIntervalloMin });
  const server = http.createServer(creaApp({ db, config }));
  server.listen(config.porta, () => console.info(`[avvio] Timbratore in ascolto sulla porta ${config.porta}`));

  const chiudi = () => {
    fermaChiusure();
    server.close(() => db.chiudi().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', chiudi);
  process.on('SIGINT', chiudi);
}

avvia().catch((e) => {
  console.error('[avvio] impossibile partire:', e.message);
  process.exit(1);
});
