import { isDev, type Env } from "../env";

export interface OutgoingEmail { to: string; subject: string; text: string }

/** Posta "inviata" nei test con EMAIL_PROVIDER=memory: resta in memoria, non esce dal Worker. */
export const memoryOutbox: OutgoingEmail[] = [];

/**
 * Per cambiare provider basta aggiungere un ramo qui.
 * - cloudflare: binding send_email di Cloudflare Email Service
 * - log: scrive sulla console, solo in sviluppo locale
 * - memory: solo per i test
 */
export async function sendEmail(env: Env, requestUrl: string, email: OutgoingEmail): Promise<void> {
  switch (env.EMAIL_PROVIDER) {
    case "cloudflare":
      if (!env.EMAIL) throw new Error("Binding EMAIL non configurato");
      await env.EMAIL.send({ to: email.to, from: env.EMAIL_FROM, subject: email.subject, text: email.text });
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
