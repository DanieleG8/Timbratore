# Timbratore — Requisiti (bozza v0.3, 21/10/2026)

Programma interno per gestire timbrature (in sede e da remoto), ferie e
permessi, e calcolare le **ore disponibili** di ogni persona da passare in
seguito al piano di lavoro del gestionale (Fluentis).

## 1. Contesto e decisioni prese

| Tema | Decisione |
|---|---|
| Dimensione | Pochi dipendenti, ma struttura **configurabile**: orari, tipi di assenza e regole sono dati, non codice. |
| Terminale in sede | Raspberry Pi con monitor e lettore badge USB già presenti. |
| Paghe | Export **Excel** mensile per CNA. Formati specifici in seguito. |
| Gestionale | Fluentis. Integrazione **rinviata**. Direzione: **il timbratore spinge** verso il gestionale. |
| Biometria | **Esclusa** (impronte e volto: il Garante Privacy le ha sanzionate per le presenze). |
| Hosting | **Railway**, come gli altri progetti. Deploy automatico dal ramo di default di GitHub. |
| Database | **PostgreSQL di Railway**. Il disco del container si azzera a ogni deploy: lì non si salva nulla. |
| Login | **Microsoft** (Entra ID) e **Google** per chi ha l'account aziendale; **credenziali locali** per gli altri. |
| Sistema attuale | **Marcatempo Plus** di ValeProg (<https://valeprog.it/Marcatempo-Plus/App.aspx>), con reportistica InOut Presenze. |

## 2. Principi di progetto

1. **Timbrature immutabili.** Si registra l'evento grezzo (chi, quando, tipo,
   dispositivo, origine). Le correzioni sono record separati che lo
   sostituiscono logicamente, con autore, data e motivo. L'originale non si
   cancella mai. Cambiando una regola si può ricalcolare il passato.
2. **Configurazione come dati.** Profili orario, tipi di assenza, festività,
   arrotondamenti: tabelle modificabili da interfaccia.
3. **Il cuore non conosce l'esterno.** Il nucleo produce *presenze
   consuntive* e *disponibilità future*. Excel per CNA, Fluentis, calendari
   sono **connettori** separati.
4. **Offline prima di tutto sul terminale.** Nessuna timbratura si perde se
   cade la rete.
5. **Ora affidabile.** L'ora della timbratura è quella del dispositivo,
   sincronizzata via NTP; il Raspberry monta un modulo RTC.

## 3. Architettura

```
                              Railway
 ┌─────────────────┐        ┌──────────────────────────────┐   ┌────────────┐
 │ Raspberry kiosk │──HTTPS─▶│ Servizio Node.js             │──▶│ PostgreSQL │
 │ badge + schermo │  coda   │  - API + web app             │   │ (Railway)  │
 │ SQLite locale   │ offline │  - motore calcolo ore        │   └────────────┘
 └─────────────────┘        │  - outbox connettori ─────────┼──▶ Excel CNA
 ┌─────────────────┐        │                              │──▶ Fluentis (poi)
 │ Web app (PWA)   │──HTTPS─▶│  login: Microsoft / Google / │
 │ dipendenti / HR │        │         credenziali locali   │
 └─────────────────┘        └──────────────────────────────┘
```

- **Server**: un servizio Node.js su Railway (stesse competenze e stesso
  flusso di deploy di orderEntry). Configurazione e segreti nelle variabili
  d'ambiente di Railway, mai nel repo.
- **Database**: PostgreSQL di Railway, con backup automatici attivi. Gli
  export Excel si generano al volo e non si salvano sul disco del container.
- **Terminale**: browser in modalità kiosk + piccolo servizio locale che legge
  il badge e tiene la coda delle timbrature non ancora inviate (SQLite sul
  Raspberry: qui il disco è persistente).
- **Web app**: servita dallo stesso servizio, installabile su telefono; usata
  per timbratura remota, cartellino, richieste, amministrazione.

### 3.1 Accesso e identità

| Chi | Come entra |
|---|---|
| Dipendente con account Microsoft aziendale | «Accedi con Microsoft» (Entra ID, OpenID Connect), **stesso tenant di orderEntry**. |
| Dipendente con account Google aziendale | «Accedi con Google» (OpenID Connect), **Google Workspace** con dominio aziendale. |
| Dipendente senza account aziendale | Email (o nome utente) + password locale. |
| Terminale Raspberry | Nessun utente: il **dispositivo** è registrato con un proprio token. Chi timbra è identificato dal badge o dal PIN. |

- Una `persona` può avere **più modi di accesso** collegati (es. Microsoft e
  password locale). Il collegamento al login esterno avviene sull'ID stabile
  del provider, non solo sull'email.
- **Niente registrazione libera**: entra solo chi è già in anagrafica.
  L'amministratore crea la persona e la abilita a uno o più modi di accesso.
- Primo accesso con credenziali locali: link di attivazione via email (o
  codice consegnato dall'HR) per scegliere la password. Stesso meccanismo per
  il recupero password.
- Password conservate con un algoritmo lento e sicuro (argon2 o bcrypt), limite
  ai tentativi, sessioni con scadenza.
- Ruoli: dipendente, responsabile, HR, amministratore. Un ruolo non dipende da
  come si è entrati.

**Microsoft (Entra ID)**
- Stesso tenant di orderEntry (`ENTRA_TENANT_ID`), ma una **registrazione app
  dedicata** (`ENTRA_CLIENT_ID` proprio), con l'indirizzo di ritorno del
  dominio Timbratore. Così permessi e indirizzi di ritorno delle due app
  restano separati.
- Stesso schema di orderEntry (`server.js`, verifica del token): il browser
  ottiene l'ID token con PKCE, il server lo verifica sulle chiavi pubbliche
  del tenant controllando `aud`, `tid` e `iss`. Persona collegata tramite
  `oid` (ID stabile dell'utente nel tenant).

**Google (Workspace)**
- Client OAuth nella console Google Cloud dell'organizzazione, tipo «Web».
  Schermata di consenso **interna**, così solo gli account del Workspace possono
  entrare.
- Il server verifica l'ID token (`aud` = client ID, firma Google) e
  **rifiuta se il campo `hd` non è il dominio aziendale**. Il controllo si fa
  sul server, non solo nella pagina. Persona collegata tramite `sub`.

**Variabili Railway previste**

| Variabile | Contenuto |
|---|---|
| `DATABASE_URL` | Fornita da Railway col database PostgreSQL. |
| `ENTRA_TENANT_ID` | Stesso valore di orderEntry. |
| `ENTRA_CLIENT_ID` | ID della nuova registrazione app «Timbratore». |
| `GOOGLE_CLIENT_ID` | Client OAuth Google. |
| `GOOGLE_HD` | Dominio Workspace ammesso. |
| `SESSION_SECRET` | Chiave per firmare le sessioni. |
| `PUBLIC_BASE_URL` | Indirizzo pubblico dell'app (per i link di attivazione e i ritorni del login). |
| `SMTP_*` | Invio email (attivazione, notifiche). |

## 4. Funzionalità

### 4.1 Timbratura in sede (Raspberry)
- Lettura badge NFC/RFID (il lettore USB si comporta come tastiera).
- Riscontro immediato: nome, tipo, ora, suono di conferma o errore.
- Tipo: alternanza automatica entrata/uscita, con tasti espliciti per
  pausa e uscita per servizio.
- PIN di riserva per badge dimenticato.
- Coda locale: le timbrature si inviano appena torna la rete; il server
  scarta i duplicati (ogni timbratura ha un ID generato sul terminale).
- Indicatore sullo schermo dello stato di rete e delle timbrature in coda.

### 4.2 Timbratura da remoto
- Da web app, con login.
- Abilitazione per persona e per giorno (calendario smart working).
- Posizione GPS **opzionale**, solo al momento della timbratura, mai
  tracciamento continuo. Da valutare col consulente (Statuto Lavoratori art. 4).
- Alternativa in sede: QR dinamico sullo schermo del Raspberry.

### 4.3 Assenze: ferie, permessi, malattia
- Tipi configurabili, ognuno con: unità (giorni/ore), riduce disponibilità
  (sì/no), scala un saldo (quale), richiede approvazione, richiede allegato o
  protocollo (es. certificato INPS).
- Flusso: richiesta → approvazione del responsabile → (opzionale) HR.
- Notifiche email/push, mai fuori orario.
- Saldi visibili: maturato, goduto, pianificato, residuo.
- Calendario del team con le assenze.

### 4.4 Motore orari
- Profili orario: fisso, flessibile (fascia di entrata), part-time, turni.
  Assegnati per persona con data di validità (dal / al).
- Calendario festività nazionali + patrono.
- Calcolo giornaliero: ore lavorate, pause, ritardi, straordinari,
  arrotondamenti configurabili.
- Anomalie: timbrature dispari, giornata senza timbrature né giustificativo,
  orari fuori fascia. Il dipendente le risolve con una richiesta di correzione.

### 4.5 Disponibilità (base per il piano di lavoro)
Per ogni persona e giorno, anche nel futuro:

> **disponibili** = ore da profilo orario − assenze approvate − festività

Più un dato del giorno corrente: **presente / assente / non ancora timbrato**.
Le assenze solo *richieste* (non approvate) si espongono a parte, come
disponibilità incerta.

### 4.6 Amministrazione
- Anagrafica dipendenti, badge, responsabili, profili orario.
- «Chi è presente adesso» (anche per evacuazione).
- Correzioni manuali sempre tracciate (prima / dopo / chi / quando / perché).
- Chiusura del mese: blocca il periodo, poi export.

### 4.7 Dipendente
- Cartellino mensile, timbrature, saldi, richieste. Export PDF.

## 5. Modello dati (prima stesura)

| Entità | Campi principali |
|---|---|
| `persona` | id, nome, cognome, email, attiva, responsabile_id, ruoli |
| `accesso` | persona_id, provider (microsoft/google/locale), id_esterno, hash_password?, ultimo_accesso |
| `badge` | codice, persona_id, valido_dal, valido_al |
| `dispositivo` | id, nome, tipo (kiosk/web), ultimo_contatto |
| `profilo_orario` | id, nome, regole (per giorno della settimana: fasce, pause, ore teoriche) |
| `assegnazione_orario` | persona_id, profilo_id, dal, al |
| `timbratura` | id (UUID dal dispositivo), persona_id, istante, tipo, origine, dispositivo_id, posizione?, ricevuta_il |
| `correzione` | id, timbratura_id?, persona_id, nuovo_istante/tipo, motivo, autore, creata_il |
| `tipo_assenza` | codice, nome, unità, riduce_disponibilità, saldo, richiede_approvazione |
| `richiesta_assenza` | id, persona_id, tipo, dal, al, ore?, stato, approvata_da, note |
| `saldo_movimento` | persona_id, saldo, quantità, causale, data |
| `festività` | data, nome |
| `periodo_chiuso` | mese, chiuso_da, chiuso_il |
| `outbox` | id, connettore, tipo_evento, payload, stato, tentativi, inviato_il |

Giornata calcolata e disponibilità sono **viste derivate**, ricalcolabili.

## 6. Connettori in uscita

Il timbratore **spinge** i dati. Ogni cambiamento rilevante (timbratura,
assenza approvata, correzione, chiusura mese) genera un evento nella tabella
`outbox`; un processo li consegna al connettore con nuovi tentativi in caso
di errore. Così il gestionale può essere irraggiungibile senza perdere nulla.

| Connettore | Stato | Contenuto |
|---|---|---|
| Excel CNA | MVP | Per persona e giorno: ore ordinarie, straordinari, assenze per tipo. Mensile, su richiesta. |
| Fluentis | Rinviato | Disponibilità future per persona/giorno + presenza del giorno. Contratto da definire. |

## 7. Privacy e aspetti legali
- Informativa GDPR ai dipendenti; registro dei trattamenti.
- Accessi per ruolo: dipendente (solo sé), responsabile (il suo team), HR/admin.
- Conservazione: definire i tempi con CNA (i dati delle paghe si conservano per anni).
- GPS: solo puntuale e solo se attivato per quella persona.
- Diritto alla disconnessione per lo smart working.

## 8. Fasi

| Fase | Contenuto |
|---|---|
| **1 — MVP** | Server, anagrafica, badge, terminale Raspberry con coda offline, profili orario, festività, ferie e permessi con approvazione, calcolo giornata, export Excel CNA. |
| **2** | Web app per dipendenti: cartellino, timbratura remota, correzione anomalie, saldi. |
| **3** | Disponibilità future esposte + connettore Fluentis. |
| **4** | Turni, banca ore, arrotondamenti avanzati, sincronizzazione calendari. |

## 9. Passaggio da Marcatempo Plus

- **Storico**: esportare da InOut Presenze le timbrature passate (foglio
  elettronico) e importarle come timbrature con origine «importata».
- **Anagrafica e badge**: importare nominativi e codici badge, così i badge
  attuali continuano a funzionare.
- **Periodo in parallelo**: per almeno un mese si timbra su entrambi i sistemi
  e si confrontano i totali mensili prima di spegnere il vecchio.
- **Raspberry**: verificare quale software ValeProg ci gira (probabilmente
  «Presenze PI»). Il nostro terminale si installa su una scheda SD nuova, così
  si può tornare indietro sostituendo la scheda.

## 10. Domande aperte
- Modello del lettore badge e tipo di badge (frequenza 125 kHz o 13,56 MHz).
- Che software ValeProg gira oggi sul Raspberry e che piano di Marcatempo avete
  (serve per sapere cosa si può esportare da InOut Presenze).
- Dominio pubblico dell'app (es. `presenze.<dominio>`), serve per gli
  indirizzi di ritorno del login.
- Dominio Google Workspace da ammettere.
- Chi crea la registrazione app su Entra e il client OAuth su Google.
- Servizio email da usare per attivazioni e notifiche (Microsoft 365?).
- Saldi iniziali di ferie e ROL: da dove si caricano?
- Struttura dell'Excel che oggi mandate a CNA (un esempio aiuterebbe).
- Chi approva le richieste: un responsabile per persona o uno unico?
