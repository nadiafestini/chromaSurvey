import { deps } from "../deps";
import { isDev, type Env } from "../env";

/** Se il secret manca la verifica fallisce: in produzione il modulo non resta mai senza protezione. */
export async function verifyTurnstile(env: Env, requestUrl: string, token: string, ip: string | null): Promise<boolean> {
  if (isDev(env, requestUrl)) return true;
  if (!env.TURNSTILE_SECRET_KEY || !token) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (ip) body.set("remoteip", ip);
  try {
    const res = await deps.fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
