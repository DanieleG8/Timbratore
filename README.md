# Timbratore

Gestione presenze: timbrature in sede (Raspberry + badge) e da remoto,
timbrature dimenticate, correzioni, chiusura automatica a mezzanotte; in
arrivo ferie e permessi e le ore disponibili per il piano di lavoro.

- Requisiti e decisioni: [docs/requisiti.md](docs/requisiti.md)
- Messa in produzione su Railway e configurazione del Raspberry: [docs/installazione.md](docs/installazione.md)

## Avvio in locale

```bash
npm install
ADMIN_EMAIL=tu@esempio.it ADMIN_PASSWORD=una-password-lunga npm start
```

Apri <http://localhost:3000> (web app) e <http://localhost:3000/kiosk>
(schermata del terminale). Senza `DATABASE_URL` i dati stanno in
`.dati-locali/`.

## Test

```bash
npm test
```

I test usano un PostgreSQL vero in memoria (pglite): non serve installare nulla.

## Struttura

| Cartella | Contenuto |
|---|---|
| `src/core/` | Regole pure, senza database: fuso orario, festività, profili orario, interpretazione della giornata, chiusura automatica. |
| `src/services/` | Operazioni sul database: timbrature, correzioni, terminale, chiusura notturna, anagrafica, accessi, riepiloghi. |
| `src/auth/` | Password, sessione, verifica token Microsoft/Google. |
| `src/db/` | Connessione (PostgreSQL / pglite) e migrazioni SQL. |
| `src/app.js` | API HTTP e file statici. `src/server.js` avvia tutto. |
| `public/` | Web app (`index.html`, `app.js`) e terminale (`kiosk.html`, `kiosk.js`). |
| `test/` | Test automatici (`node --test`). |

## Regole chiave

- Le timbrature **non si modificano mai**: una correzione annulla l'originale
  (che resta visibile) e ne crea una nuova; tutto finisce nel registro `correzione`.
- **Entrata/uscita si calcola** dalla sequenza della giornata (la prima è sempre
  un'entrata); un verso dichiarato vince. Un'uscita dimenticata non fa
  slittare i giorni successivi.
- **Chiusura automatica**: dopo mezzanotte le giornate aperte ricevono
  un'uscita all'orario di fine turno, da confermare. Se poi arriva l'uscita
  vera, quella automatica non conta più.
- **Timbratura dimenticata**: il dipendente la inserisce da solo, con un
  motivo, entro 7 giorni; conta subito ma resta segnata ✍ «inserita a mano».
