# Guida: login Microsoft (Entra ID)

Da fare con un account che può registrare applicazioni nel tenant Chromavis, su [entra.microsoft.com](https://entra.microsoft.com).

## 1. Registrare l'applicazione
1. **Identity** → **Applications** → **App registrations** → **New registration**.
2. **Name:** `ChromaSurvey`.
3. **Supported account types:** *Accounts in this organizational directory only*.
4. **Redirect URI:** tipo **Web**, valore `https://<dominio>/auth/microsoft/callback`.
5. **Register**.
6. Dalla pagina **Overview** copia in `wrangler.jsonc`:
   - **Application (client) ID** → `ENTRA_CLIENT_ID`
   - **Directory (tenant) ID** → `ENTRA_TENANT_ID`

## 2. Creare il secret
1. **Certificates & secrets** → **New client secret**.
2. Copia subito il **Value** e salvalo su Cloudflare come secret `ENTRA_CLIENT_SECRET`.
3. Annota la scadenza: alla scadenza il login Microsoft smette di funzionare.

## 3. Permessi del token
1. **API permissions**: verifica che ci sia `User.Read` delegato; aggiungi `openid`, `profile`, `email` se mancano.
2. **Token configuration** → **Add optional claim** → **ID** → `email`.

## 4. Ruolo admin
Finché il gruppo non è definito, in `wrangler.jsonc`:
- `ENTRA_ADMIN_GROUP_ID` resta `PLACEHOLDER_ADMIN_GROUP` e non dà a nessuno il ruolo admin
- `ADMIN_EMAILS` contiene gli indirizzi admin separati da virgola: vale solo per il login Microsoft

Quando il gruppo (ad esempio `itchr_mai_users`) è pronto:
1. Verifica che sia visibile in **Groups**. Se esiste solo in AD on-premises, va prima sincronizzato.
2. Copia il suo **Object ID** in `ENTRA_ADMIN_GROUP_ID`.
3. **Token configuration** → **Add groups claim**:
   - Con Entra ID P1/P2: **Groups assigned to the application**, poi assegna il gruppo in **Enterprise applications** → ChromaSurvey → **Users and groups**.
   - Senza P1/P2: **Security groups**. Attenzione: chi appartiene a più di 200 gruppi non riceve la lista nel token e risulterà utente normale.
4. In **ID** lascia **Group ID**.
5. Svuota `ADMIN_EMAILS`.

Il ruolo si ricalcola a ogni login: chi esce dal gruppo perde il ruolo admin al login successivo, al massimo dopo 8 ore (durata della sessione).

Chi entra con Microsoft senza essere nel gruppo è un utente normale.
