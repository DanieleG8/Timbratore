'use strict';

// Errore con un messaggio pensato per l'utente e un codice HTTP.
class ErroreApi extends Error {
  constructor(status, messaggio, codice) {
    super(messaggio);
    this.status = status;
    this.codice = codice || null;
  }
}

const richiesta = (m, c) => new ErroreApi(400, m, c);
const nonTrovato = (m) => new ErroreApi(404, m || 'Non trovato');
const vietato = (m) => new ErroreApi(403, m || 'Operazione non consentita');
const conflitto = (m, c) => new ErroreApi(409, m, c);

module.exports = { ErroreApi, richiesta, nonTrovato, vietato, conflitto };
