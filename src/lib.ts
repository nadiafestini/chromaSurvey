const encoder = new TextEncoder();

export const nowIso = () => new Date().toISOString();
export const addMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...view)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function sha256Raw(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Codice numerico uniforme a 6 cifre, con rejection sampling per evitare il bias del modulo. */
export function randomOtp(): string {
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  const out = new Uint32Array(1);
  do crypto.getRandomValues(out);
  while (out[0]! >= limit);
  return String(out[0]! % 1_000_000).padStart(6, "0");
}

export function normalizeEmail(input: unknown): string | null {
  const email = String(input ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function emailHasDomain(email: string, domainsCsv: string): boolean {
  const domain = email.split("@")[1] ?? "";
  return domainsCsv
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Accetta solo percorsi interni, per evitare redirect verso altri siti. */
export function safeNext(next: unknown, fallback = "/"): string {
  const path = String(next ?? "");
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") ? path : fallback;
}

export async function audit(db: D1Database, actor: string | null, action: string, detail: unknown = null): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (actor, action, detail_json, occurred_at) VALUES (?, ?, ?, ?)")
    .bind(actor, action, detail === null ? null : JSON.stringify(detail), nowIso())
    .run();
}

/** Limite di frequenza a finestra fissa. Restituisce false quando il limite è superato. */
export async function rateLimit(db: D1Database, key: string, max: number, windowSeconds: number): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= max;
}

/** Pulizia dei dati temporanei scaduti, eseguita durante i login. */
export async function purgeExpired(db: D1Database): Promise<void> {
  const now = nowIso();
  const dayAgo = Math.floor(Date.now() / 1000) - 86_400;
  await db.batch([
    db.prepare("DELETE FROM otp_codes WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM oidc_states WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(dayAgo)
  ]);
}
