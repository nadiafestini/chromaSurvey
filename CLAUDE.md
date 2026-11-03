# ChromaSurvey

Sito di questionari per il personale Chromavis (Microsoft SSO) e i clienti esterni (OTP via email, inviata con Microsoft Graph). TypeScript, Cloudflare Workers, Hono con pagine lato server, D1. Repo: `nadiafestini/chromaSurvey`. Il deploy su Cloudflare lo fa il responsabile dell'utente (`docs/GUIDA_CLOUDFLARE.md`).

Sul server Node è portable: `C:\Users\claude_svc\tools\node`, da aggiungere al PATH.

- `npm test`, `npm run typecheck`
- Locale: `.dev.vars` (non nel repo) con `DEV_MODE=true`, `APP_ORIGIN=http://localhost:8787`, `EMAIL_PROVIDER=log`, `OTP_PEPPER`. `npm run db:local`, poi `npm run dev`. Il codice OTP compare nella console; admin di prova con `/dev/login?role=admin`, attivo solo in locale.

## Regole da non cambiare senza chiedere
- **Classificatore:** `classifier/` è il pacchetto ufficiale v1.1. Parametri solo dal JSON, mai modificati nel codice: una modifica richiede una nuova versione decisa dal Data Management. `src/cluster/classifier.ts` deve superare tutti i 78 casi di `casi_test_v1_1.csv`.
- **Risposte:** si salvano solo i codici. L'indice `12.a` / `13.A1.a` è ricavato e uguale in ogni lingua.
- **Ruoli:** il ruolo sta nella sessione. Un OTP non dà mai il ruolo admin. Admin = gruppo Entra (`ENTRA_ADMIN_GROUP_ID`, oggi placeholder al posto di `itchr_mai_users`) o `ADMIN_EMAILS`, solo con login Microsoft.
- **Accesso esterni:** qualunque email con OTP; `@chromavis.com` solo Microsoft.
- **Trappola:** il caso viene classificato e segnalato in revisione, non escluso.
- **Privacy:** testo solo in inglese in `legal/legal.json`; cambiare `version` richiede una nuova conferma a tutti. `consent_events` è non modificabile (trigger).
- **Revoca:** profilo bloccato e sessioni chiuse; risposte conservate ma fuori da report ed export; sblocco solo da admin con nuova conferma. Un admin conserva il backend.
- **Definizioni riservate:** `content/clusters.admin.json` si importa solo in `src/views/admin.ts`, mai nelle pagine utente.
- **CSP:** niente script, stili o attributi `on*`/`style` inline. Barre e grafici sono SVG con attributi.
- **Dati personali:** Excel del pilota, `import/` e `.dev.vars` non vanno mai nel repo. Export CSV senza nome ed email.

## Modificare i contenuti
- Questionario: `python scripts/build_survey.py <ENG.md> <ITA.md>` rigenera `surveys/survey1.json`. Se cambia, aumentare `version`.
- Testi legali e definizioni: placeholder in `legal/legal.json` e `content/*.json`.

## Fase successiva (non costruita)
Profilazione (Q5, Q6, Q22-Q73 del Word), lista prodotti gestita dall'admin, invio prodotti, questionari sui prodotti.
