import { sendEmail } from "../email/sender";
import type { Env, Lang } from "../env";
import { addMinutes, hmacHex, nowIso, purgeExpired, randomOtp, rateLimit, safeEqual } from "../lib";
import { t } from "../i18n";

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;

function pepper(env: Env): string {
  if (!env.OTP_PEPPER) throw new Error("Secret OTP_PEPPER non configurato");
  return env.OTP_PEPPER;
}

const codeHmac = (env: Env, email: string, code: string) => hmacHex(pepper(env), `${email}:${code}`);

/**
 * Prepara e invia il codice. Non restituisce nulla al chiamante: la risposta all'utente è sempre
 * la stessa, così non si può scoprire quali indirizzi esistono o sono bloccati.
 */
export async function issueOtp(
  env: Env,
  requestUrl: string,
  email: string,
  name: string,
  lang: Lang
): Promise<void> {
  await purgeExpired(env.DB);
  if (!(await rateLimit(env.DB, `otp-email:${email}`, 5, 900))) return;

  const user = await env.DB.prepare("SELECT status FROM users WHERE email = ?").bind(email).first<{ status: string }>();
  try {
    if (user?.status === "blocked") {
      await sendEmail(env, requestUrl, { to: email, subject: t(lang, "emailBlockedSubject"), text: t(lang, "emailBlockedBody") });
      return;
    }
    const code = randomOtp();
    const now = nowIso();
    await env.DB.batch([
      // Un nuovo codice annulla quelli precedenti.
      env.DB.prepare("UPDATE otp_codes SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL").bind(now, email),
      env.DB
        .prepare("INSERT INTO otp_codes (email, name, code_hmac, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(email, name, await codeHmac(env, email, code), now, addMinutes(CODE_MINUTES))
    ]);
    await sendEmail(env, requestUrl, {
      to: email,
      subject: t(lang, "emailOtpSubject"),
      text: t(lang, "emailOtpBody").replace("{code}", code)
    });
  } catch (error) {
    // L'indirizzo non finisce nel log.
    console.error("Invio OTP non riuscito:", error instanceof Error ? error.message : "errore sconosciuto");
  }
}

/** Restituisce il nome indicato alla richiesta se il codice è valido, altrimenti null. */
export async function verifyOtp(env: Env, email: string, code: string): Promise<{ name: string | null } | null> {
  const row = await env.DB
    .prepare(
      `SELECT id, name, code_hmac, attempts FROM otp_codes
       WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY id DESC LIMIT 1`
    )
    .bind(email, nowIso())
    .first<{ id: number; name: string | null; code_hmac: string; attempts: number }>();
  if (!row) return null;

  // Il tentativo si conta prima del confronto, anche con richieste in parallelo.
  const counted = await env.DB
    .prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ? AND consumed_at IS NULL")
    .bind(row.id, MAX_ATTEMPTS)
    .run();
  if (counted.meta.changes !== 1) return null;

  if (!safeEqual(await codeHmac(env, email, code), row.code_hmac)) return null;

  // Monouso anche in caso di richieste contemporanee.
  const consumed = await env.DB
    .prepare("UPDATE otp_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
    .bind(nowIso(), row.id)
    .run();
  return consumed.meta.changes === 1 ? { name: row.name } : null;
}
