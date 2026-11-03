# Guida: pubblicare ChromaSurvey su Cloudflare

Per chi ha accesso all'account Cloudflare. Tutti i passi sono da interfaccia grafica, salvo dove serve la riga di comando.

## 1. Creare il database (D1)
1. Cloudflare → **Storage & Databases** → **D1 SQL Database** → **Create**.
2. Nome: `chromasurvey`.
3. In **Data location** scegli **Jurisdiction: EU**. Non si può cambiare dopo la creazione.
4. Copia il **Database ID**.
5. In `wrangler.jsonc` sostituisci `database_id` con quell'ID e fai il commit.

Da riga di comando è equivalente: `npx wrangler d1 create chromasurvey --jurisdiction eu`

## 2. Collegare il repo
1. **Workers & Pages** → **Create** → **Import a repository** → GitHub → `nadiafestini/chromaSurvey`.
2. Branch: `main`.
3. **Build command:** `npm ci`
4. **Deploy command:** `npx wrangler d1 migrations apply chromasurvey --remote && npx wrangler deploy`

Ogni push su `main` pubblica il sito.

## 3. Dominio
1. Worker `chromasurvey` → **Settings** → **Domains & Routes** → **Add** → **Custom domain**.
2. In `wrangler.jsonc` imposta `APP_ORIGIN` con lo stesso indirizzo, ad esempio `https://survey.chromavis.com`, senza `/` finale.

Se `APP_ORIGIN` è sbagliato, tutti i moduli rispondono 403 e il login Microsoft fallisce.

## 4. Turnstile
1. **Turnstile** → **Add widget** → aggiungi il dominio → modalità **Managed**.
2. Copia la **Site key** in `TURNSTILE_SITE_KEY` in `wrangler.jsonc`.
3. Conserva la **Secret key** per il passo 6.

## 5. Email dei codici
I codici partono da una casella aziendale con Microsoft Graph, non da Cloudflare.

1. Prepara l'app per la posta e la casella come indicato in `docs/GUIDA_ENTRA.md`, sezione 5.
2. In `wrangler.jsonc` imposta `GRAPH_CLIENT_ID` con il client ID di quell'app ed `EMAIL_FROM` con l'indirizzo della casella.

Per cambiare provider si modifica solo `src/email/sender.ts`.

## 6. Secret
Worker `chromasurvey` → **Settings** → **Variables and Secrets** → **Add** → tipo **Secret**:

| Nome | Valore |
|---|---|
| `OTP_PEPPER` | Stringa casuale lunga, da generare e non riutilizzare |
| `TURNSTILE_SECRET_KEY` | Dal passo 4 |
| `ENTRA_CLIENT_SECRET` | App del login, da `docs/GUIDA_ENTRA.md` |
| `GRAPH_CLIENT_SECRET` | App della posta, da `docs/GUIDA_ENTRA.md` |

## 7. Verifica dopo il deploy
1. Apri il sito: compare il login.
2. Da terminale: `curl -I https://<dominio>/login`. Devono esserci `Content-Security-Policy`, `Permissions-Policy`, `Referrer-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`.
3. Prova il codice via email con un indirizzo esterno. Se non arriva, la pagina non lo mostra: nei log del Worker cerca `Invio OTP non riuscito:`.
4. Prova Microsoft con un admin e con un non admin.

## 8. Importare il pilota (una sola volta)
Il file SQL contiene nomi ed email: non va nel repo e va cancellato dopo l'uso.

```
python scripts/import_pilot.py "CLUSTER  CONSUMING MAPPING1-64.xlsx" import/pilot.sql
npx wrangler d1 execute chromasurvey --remote --file import/pilot.sql
```

Risultato atteso: 63 righe, 62 persone, 62 completate e 1 archiviata.

Poi entra come admin: nel report compare **Calcola i cluster**. Cliccalo finché non restano risposte da classificare (40 alla volta).

## Prima del go-live
- [ ] Testi legali definitivi in `legal/legal.json`, con `isPlaceholder` a `false` e una nuova `version`
- [ ] Gruppo admin reale in `ENTRA_ADMIN_GROUP_ID` e `ADMIN_EMAILS` svuotato
- [ ] Definizioni dei cluster definitive in `content/clusters.json` e `content/clusters.admin.json`
