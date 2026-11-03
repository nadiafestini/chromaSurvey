import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Role, SessionUser } from "../env";
import { addMinutes, nowIso, randomToken, sha256Hex } from "../lib";

export const SESSION_COOKIE = "__Host-cs_session";
const SESSION_HOURS = 8;

export async function createSession(
  c: Context<AppEnv>,
  userId: string,
  role: Role,
  method: "microsoft" | "otp" | "dev"
): Promise<void> {
  const token = randomToken();
  await c.env.DB.batch([
    c.env.DB
      .prepare("INSERT INTO sessions (token_hash, user_id, role, auth_method, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(await sha256Hex(token), userId, role, method, nowIso(), addMinutes(SESSION_HOURS * 60)),
    c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(nowIso(), userId)
  ]);
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_HOURS * 3600
  });
}

export async function loadSessionUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const row = await c.env.DB
    .prepare(
      `SELECT u.id, u.email, u.name, u.status, u.user_type AS userType, s.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .bind(await sha256Hex(token), nowIso())
    .first<SessionUser>();
  return row ?? null;
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}
