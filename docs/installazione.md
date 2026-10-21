# Installazione

## 1. Railway

1. Nel progetto Railway: **New → GitHub Repo → Timbratore**. Railway legge
   `railway.json` (avvio `node src/server.js`, controllo su `/health`).
2. **New → Database → PostgreSQL** nello stesso progetto.
3. Nel servizio Timbratore, **Variables** (elenco completo in `.env.example`):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (riferimento al database);
   - `SESSION_SECRET` = stringa casuale lunga;
   - `PUBLIC_BASE_URL` = indirizzo pubblico, es. `https://presenze.<dominio>`;
   - `ADMIN_EMAIL` (e facoltativa `ADMIN_PASSWORD`) per il primo amministratore;
   - `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_HD`
     quando i login aziendali sono pronti (vedi sotto).
4. **Settings → Networking**: dominio personalizzato + record CNAME nel DNS.
5. Nel database PostgreSQL attiva i **backup** (Railway → database → Backups).

Le tabelle si creano da sole al primo avvio (cartella `src/db/migrazioni/`).

## 2. Login Microsoft (Entra ID)

Portale Entra → **Registrazioni app → Nuova registrazione**, nello stesso
tenant di orderEntry:

- Nome: «Timbratore»; account: «Solo questa directory organizzativa».
- **URI di reindirizzamento**: piattaforma **Single-page application**,
  valore `PUBLIC_BASE_URL` + `/` (es. `https://presenze.<dominio>/`).
- Copia **ID applicazione (client)** in `ENTRA_CLIENT_ID` e **ID directory
  (tenant)** in `ENTRA_TENANT_ID`.

Non servono segreti né permessi aggiuntivi: bastano `openid profile email`.

## 3. Login Google Workspace

Google Cloud Console dell'organizzazione → **API e servizi**:

- **Schermata consenso OAuth**: tipo **Interno**.
- **Credenziali → Crea ID client OAuth** di tipo **Applicazione web**;
  **Origini JavaScript autorizzate**: `PUBLIC_BASE_URL`.
- Copia l'ID client in `GOOGLE_CLIENT_ID`; in `GOOGLE_HD` il dominio
  Workspace (es. `azienda.it`).

## 4. Prima configurazione nell'app

Entra come amministratore e, in quest'ordine:

1. **Impostazioni → Profili orario**: crea almeno un profilo (es. «Ufficio»).
2. **Impostazioni → Festività aziendali**: il patrono.
3. **Persone**: aggiungi le persone con la loro email aziendale. Per ognuna:
   badge, profilo orario, e — per chi non ha Microsoft/Google — «Link per
   creare la password» da mandargli.
4. **Impostazioni → Terminali → Aggiungi terminale**: copia il codice che
   compare (si vede una volta sola).

## 5. Raspberry (terminale in sede)

Su una **scheda SD nuova** (così per tornare a Marcatempo basta rimettere la
vecchia):

1. Installa **Raspberry Pi OS** (con desktop) e collegalo alla rete.
2. **Ora corretta**: modulo RTC (es. DS3231) e sincronizzazione NTP attiva
   (`timedatectl` deve dire `System clock synchronized: yes`). Fuso orario
   `Europe/Rome`.
3. Avvio automatico di Chromium a schermo intero sulla pagina del terminale,
   ad esempio in `~/.config/labwc/autostart` (Raspberry Pi OS Bookworm):

   ```bash
   chromium-browser --kiosk --noerrdialogs --disable-infobars \
     --disable-session-crashed-bubble --check-for-update-interval=31536000 \
     https://presenze.<dominio>/kiosk
   ```

4. Al primo avvio incolla il **codice del terminale**. Da lì in poi: passa il
   badge → nome, entrata/uscita e ora a schermo.
5. Senza rete le timbrature restano salvate sul terminale («N da inviare» in
   basso) e partono da sole quando la rete torna.

Il lettore badge USB deve funzionare «come tastiera» (scrive il codice e
preme Invio): la maggior parte dei lettori RFID/NFC USB lo fa di serie. Per
verificarlo, aprire un editor di testo e passare un badge.
