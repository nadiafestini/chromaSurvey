-- ChromaSurvey: schema iniziale

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,            -- sempre minuscola
  name TEXT,
  entra_oid TEXT UNIQUE,
  user_type TEXT NOT NULL CHECK (user_type IN ('internal', 'external')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  lang TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en', 'it')),
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

-- Il ruolo vive nella sessione: dipende da come si è entrati, e un OTP non dà mai il ruolo admin.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  auth_method TEXT NOT NULL CHECK (auth_method IN ('microsoft', 'otp', 'dev')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT,
  code_hmac TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_otp_email ON otp_codes(email, created_at);

CREATE TABLE oidc_states (
  state_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- Registro non modificabile: i trigger impediscono modifiche e cancellazioni.
CREATE TABLE consent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('confirm', 'revoke', 'unblock', 'not_recorded')),
  notice_version TEXT NOT NULL,
  language TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('platform', 'forms_pilot', 'admin')),
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_consent_user ON consent_events(user_id, id);
CREATE TRIGGER consent_events_no_update BEFORE UPDATE ON consent_events
BEGIN SELECT RAISE(ABORT, 'consent_events is append-only'); END;
CREATE TRIGGER consent_events_no_delete BEFORE DELETE ON consent_events
BEGIN SELECT RAISE(ABORT, 'consent_events is append-only'); END;

CREATE TABLE surveys (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL
);

CREATE TABLE survey_versions (
  id TEXT PRIMARY KEY,                   -- "<survey>@<versione>"
  survey_id TEXT NOT NULL REFERENCES surveys(id),
  version TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  published_at TEXT NOT NULL
);

CREATE TABLE responses (
  id TEXT PRIMARY KEY,
  rid TEXT NOT NULL UNIQUE,              -- identificativo senza dati personali, usato negli export
  user_id TEXT NOT NULL REFERENCES users(id),
  survey_id TEXT NOT NULL REFERENCES surveys(id),
  survey_version_id TEXT NOT NULL REFERENCES survey_versions(id),
  source TEXT NOT NULL CHECK (source IN ('platform', 'forms_pilot')),
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'archived')),
  language TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  excluded_at TEXT,
  excluded_by TEXT,
  note TEXT
);
-- Una sola compilazione valida per utente e questionario.
CREATE UNIQUE INDEX idx_responses_one_per_user ON responses(user_id, survey_id) WHERE status <> 'archived';

-- Si salvano solo i codici, mai i testi: l'indice 12.a è ricavato e non dipende dalla lingua.
CREATE TABLE answers (
  response_id TEXT NOT NULL REFERENCES responses(id),
  question_id TEXT NOT NULL,             -- Q12, Q13...
  item_code TEXT NOT NULL DEFAULT '',    -- A1...A18, TRAP per la griglia
  option_code INTEGER NOT NULL DEFAULT 0,
  text_value TEXT,                       -- solo domande a testo libero (Q2)
  PRIMARY KEY (response_id, question_id, item_code, option_code)
);

CREATE TABLE cluster_results (
  response_id TEXT NOT NULL REFERENCES responses(id),
  classifier_version TEXT NOT NULL,
  cluster TEXT,
  cluster_name TEXT,
  cluster_2 TEXT,
  margin REAL,
  score_max REAL,
  confidence TEXT,
  weak_profile INTEGER,
  rule TEXT,
  scores_json TEXT,
  affinities_json TEXT,
  flags_json TEXT,
  error TEXT,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (response_id, classifier_version)
);

CREATE TABLE review_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id TEXT NOT NULL REFERENCES responses(id),
  flag TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept', 'excluded')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  UNIQUE (response_id, flag)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  action TEXT NOT NULL,
  detail_json TEXT,
  occurred_at TEXT NOT NULL
);
