import { deps } from "../deps";
import { isDev, type Env } from "../env";

export interface OutgoingEmail { to: string; subject: string; text: string }

/** Posta "inviata" nei test con EMAIL_PROVIDER=memory: resta in memoria, non esce dal Worker. */
export const memoryOutbox: OutgoingEmail[] = [];

/** Codice di errore restituito da Microsoft. Mai il messaggio completo, che può contenere indirizzi. */
async function errorCode(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string | { code?: string } } | null;
  const code = typeof data?.error === "string" ? data.error : data?.error?.code;
  return `HTTP ${res.status}${code ? ` ${code}` : ""}`;
}

/**
 * Invio con Microsoft Graph: l'app dedicata alla posta si autentica da sola (client credentials)
 * e scrive dalla casella EMAIL_FROM. Il codice OTP non resta nella Posta inviata.
 */
async function sendWithGraph(env: Env, email: OutgoingEmail): Promise<void> {
  if (!env.GRAPH_CLIENT_ID || env.GRAPH_CLIENT_ID.startsWith("PLACEHOLDER")) throw new Error("GRAPH_CLIENT_ID non configurato");
  if (!env.GRAPH_CLIENT_SECRET) throw new Error("Secret GRAPH_CLIENT_SECRET non configurato");

  const tokenRes = await deps.fetch(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.GRAPH_CLIENT_ID,
      client_secret: env.GRAPH_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials"
    })
  });
  if (!tokenRes.ok) throw new Error(`Token Graph non ottenuto: ${await errorCode(tokenRes)}`);
  const { access_token: token } = (await tokenRes.json()) as { access_token?: string };
  if (!token) throw new Error("Token Graph assente nella risposta");

  const res = await deps.fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.EMAIL_FROM)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: email.subject,
        body: { contentType: "Text", content: email.text },
        toRecipients: [{ emailAddress: { address: email.to } }]
      },
      saveToSentItems: false
    })
  });
  if (res.status !== 202) throw new Error(`Invio Graph rifiutato: ${await errorCode(res)}`);
}

/**
 * Per cambiare provider basta aggiungere un ramo qui.
 * - graph: Microsoft Graph, dalla casella aziendale EMAIL_FROM
 * - log: scrive sulla console, solo in sviluppo locale
 * - memory: solo per i test
 */
export async function sendEmail(env: Env, requestUrl: string, email: OutgoingEmail): Promise<void> {
  switch (env.EMAIL_PROVIDER) {
    case "graph":
      await sendWithGraph(env, email);
      return;
    case "memory":
      memoryOutbox.push(email);
      return;
    case "log":
      if (!isDev(env, requestUrl)) throw new Error("EMAIL_PROVIDER=log è ammesso solo in locale");
      console.log(`[email locale] a ${email.to}: ${email.subject}\n${email.text}`);
      return;
    default:
      throw new Error(`EMAIL_PROVIDER sconosciuto: ${env.EMAIL_PROVIDER}`);
  }
}
