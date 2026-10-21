-- Schema iniziale. Vedi docs/requisiti.md §5.

CREATE TABLE persona (
  id                serial PRIMARY KEY,
  nome              text NOT NULL,
  cognome           text NOT NULL,
  email             text,
  attiva            boolean NOT NULL DEFAULT true,
  responsabile_id   int REFERENCES persona(id),
  ruoli             text[] NOT NULL DEFAULT '{dipendente}',
  remoto_abilitato  boolean NOT NULL DEFAULT false,
  sessione_versione int NOT NULL DEFAULT 1,
  creata_il         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX persona_email ON persona (lower(email)) WHERE email IS NOT NULL;

-- Modi di accesso: una persona può averne più d'uno.
CREATE TABLE accesso (
  id                 serial PRIMARY KEY,
  persona_id         int NOT NULL REFERENCES persona(id) ON DELETE CASCADE,
  provider           text NOT NULL CHECK (provider IN ('microsoft', 'google', 'locale')),
  id_esterno         text,
  hash_password      text,
  attivazione_hash   text,
  attivazione_scade  timestamptz,
  ultimo_accesso     timestamptz,
  UNIQUE (persona_id, provider)
);
CREATE UNIQUE INDEX accesso_esterno ON accesso (provider, id_esterno) WHERE id_esterno IS NOT NULL;
CREATE UNIQUE INDEX accesso_attivazione ON accesso (attivazione_hash) WHERE attivazione_hash IS NOT NULL;

CREATE TABLE badge (
  id          serial PRIMARY KEY,
  codice      text NOT NULL,
  persona_id  int NOT NULL REFERENCES persona(id),
  valido_dal  date NOT NULL,
  valido_al   date
);
-- un codice badge appartiene a una sola persona alla volta
CREATE UNIQUE INDEX badge_attivo ON badge (codice) WHERE valido_al IS NULL;

CREATE TABLE dispositivo (
  id               serial PRIMARY KEY,
  nome             text NOT NULL,
  tipo             text NOT NULL DEFAULT 'kiosk' CHECK (tipo IN ('kiosk')),
  token_hash       text NOT NULL UNIQUE,
  attivo           boolean NOT NULL DEFAULT true,
  ultimo_contatto  timestamptz,
  creato_il        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profilo_orario (
  id                    serial PRIMARY KEY,
  nome                  text NOT NULL UNIQUE,
  regole                jsonb NOT NULL,
  tolleranza_notte_min  int NOT NULL DEFAULT 120
);

CREATE TABLE assegnazione_orario (
  id          serial PRIMARY KEY,
  persona_id  int NOT NULL REFERENCES persona(id),
  profilo_id  int NOT NULL REFERENCES profilo_orario(id),
  dal         date NOT NULL,
  al          date,
  CHECK (al IS NULL OR al >= dal)
);
CREATE INDEX assegnazione_persona ON assegnazione_orario (persona_id, dal);

-- Timbrature: non si modificano. Una correzione annulla (una volta sola) e
-- ne inserisce una nuova che punta all'originale con sostituisce_id.
CREATE TABLE timbratura (
  id                uuid PRIMARY KEY,
  persona_id        int NOT NULL REFERENCES persona(id),
  istante           timestamptz NOT NULL,
  verso_dichiarato  text NOT NULL DEFAULT 'auto' CHECK (verso_dichiarato IN ('auto', 'entrata', 'uscita')),
  origine           text NOT NULL CHECK (origine IN ('kiosk', 'web', 'manuale', 'correzione', 'automatica', 'importata')),
  dispositivo_id    int REFERENCES dispositivo(id),
  badge             text,
  posizione         jsonb,
  nota              text,
  creata_da         int REFERENCES persona(id),
  sostituisce_id    uuid REFERENCES timbratura(id),
  da_confermare     boolean NOT NULL DEFAULT false,
  confermata_il     timestamptz,
  confermata_da     int REFERENCES persona(id),
  annullata_il      timestamptz,
  annullata_motivo  text,
  annullata_da      int REFERENCES persona(id),
  ricevuta_il       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timbratura_persona_istante ON timbratura (persona_id, istante);

-- Registro di ogni intervento sulle timbrature (chi, cosa, prima/dopo, perché).
CREATE TABLE correzione (
  id                   serial PRIMARY KEY,
  tipo                 text NOT NULL CHECK (tipo IN ('aggiunta', 'spostamento', 'verso', 'annullamento', 'conferma', 'manuale', 'chiusura_automatica')),
  persona_id           int NOT NULL REFERENCES persona(id),
  timbratura_id        uuid REFERENCES timbratura(id),
  nuova_timbratura_id  uuid REFERENCES timbratura(id),
  prima                jsonb,
  dopo                 jsonb,
  motivo               text NOT NULL,
  autore_id            int REFERENCES persona(id),
  autore_tipo          text NOT NULL DEFAULT 'persona' CHECK (autore_tipo IN ('persona', 'sistema')),
  creata_il            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX correzione_persona ON correzione (persona_id, creata_il);

-- Al massimo una chiusura automatica per persona e giornata, anche se il
-- processo gira due volte o riparte dopo un riavvio.
CREATE TABLE chiusura_automatica (
  persona_id     int NOT NULL REFERENCES persona(id),
  giorno         date NOT NULL,
  timbratura_id  uuid NOT NULL,
  creata_il      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (persona_id, giorno)
);

-- Festività in più rispetto a quelle nazionali (patrono, chiusure aziendali).
CREATE TABLE festivita (
  data  date PRIMARY KEY,
  nome  text NOT NULL
);

CREATE TABLE periodo_chiuso (
  mese       text PRIMARY KEY CHECK (mese ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  chiuso_da  int REFERENCES persona(id),
  chiuso_il  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE impostazione (
  chiave  text PRIMARY KEY,
  valore  jsonb NOT NULL
);

-- Assenze (ferie, permessi…): tabelle pronte, il flusso arriva nel prossimo passo.
CREATE TABLE tipo_assenza (
  codice                text PRIMARY KEY,
  nome                  text NOT NULL,
  unita                 text NOT NULL CHECK (unita IN ('giorni', 'ore')),
  riduce_disponibilita  boolean NOT NULL DEFAULT true,
  saldo                 text,
  richiede_approvazione boolean NOT NULL DEFAULT true,
  attivo                boolean NOT NULL DEFAULT true
);

CREATE TABLE richiesta_assenza (
  id            serial PRIMARY KEY,
  persona_id    int NOT NULL REFERENCES persona(id),
  tipo          text NOT NULL REFERENCES tipo_assenza(codice),
  dal           date NOT NULL,
  al            date NOT NULL,
  ore           numeric(6, 2),
  stato         text NOT NULL DEFAULT 'richiesta' CHECK (stato IN ('richiesta', 'approvata', 'rifiutata', 'annullata')),
  note          text,
  approvata_da  int REFERENCES persona(id),
  creata_il     timestamptz NOT NULL DEFAULT now(),
  CHECK (al >= dal)
);

CREATE TABLE saldo_movimento (
  id          serial PRIMARY KEY,
  persona_id  int NOT NULL REFERENCES persona(id),
  saldo       text NOT NULL,
  quantita    numeric(8, 2) NOT NULL,
  causale     text NOT NULL,
  data        date NOT NULL,
  creato_il   timestamptz NOT NULL DEFAULT now()
);

-- Eventi da consegnare ai connettori esterni (Fluentis, …): vedi requisiti §6.
CREATE TABLE outbox (
  id                  bigserial PRIMARY KEY,
  connettore          text NOT NULL,
  tipo_evento         text NOT NULL,
  payload             jsonb NOT NULL,
  stato               text NOT NULL DEFAULT 'da_inviare' CHECK (stato IN ('da_inviare', 'inviato', 'errore')),
  tentativi           int NOT NULL DEFAULT 0,
  prossimo_tentativo  timestamptz NOT NULL DEFAULT now(),
  ultimo_errore       text,
  creato_il           timestamptz NOT NULL DEFAULT now(),
  inviato_il          timestamptz
);

INSERT INTO tipo_assenza (codice, nome, unita, saldo) VALUES
  ('FERIE', 'Ferie', 'giorni', 'ferie'),
  ('ROL', 'Permesso ROL', 'ore', 'rol'),
  ('EXFEST', 'Ex festività', 'ore', 'exfest'),
  ('MAL', 'Malattia', 'giorni', NULL),
  ('L104', 'Permesso legge 104', 'ore', NULL);
UPDATE tipo_assenza SET richiede_approvazione = false WHERE codice = 'MAL';

INSERT INTO impostazione (chiave, valore) VALUES
  ('manuale_max_giorni', '7');
