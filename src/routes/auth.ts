import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { beginLogin, completeLogin, entraConfigured, isInternalEmail, type EntraIdentity } from "../auth/entra";
import { issueOtp, verifyOtp } from "../auth/otp";
import { createSession, destroySession } from "../auth/session";
import { verifyTurnstile } from "../auth/turnstile";
import { isDev, type AppEnv } from "../env";
import type { StringKey } from "../i18n";
import { audit, normalizeEmail, nowIso, purgeExpired, rateLimit, safeEqual } from "../lib";
import { blockedPage, loginPage, otpVerifyPage } from "../views/auth";
import { pageContext } from "./context";

const OIDC_COOKIE = "__Host-cs_oidc";

export const authRoutes = new Hono<AppEnv>();

const clientIp = (c: Context<AppEnv>) => c.req.header("CF-Connecting-IP") ?? null;

authRoutes.get("/login", (c) => {
  if (c.get("user")) return c.redirect("/home");
  const codes: Record<string, StringKey> = { microsoft_failed: "msFailed", microsoft_unavailable: "msUnavailable", use_microsoft: "useMicrosoft" };
  return c.html(loginPage(pageContext(c), { siteKey: c.env.TURNSTILE_SITE_KEY, error: codes[c.req.query("error") ?? ""] }));
});

authRoutes.post("/auth/otp/request", async (c) => {
  const body = await c.req.parseBody();
  const form = { first: String(body.first ?? "").trim(), last: String(body.last ?? "").trim(), email: String(body.email ?? "").trim() };
  const render = (error: StringKey, status: 400 | 429) =>
    c.html(loginPage(pageContext(c), { siteKey: c.env.TURNSTILE_SITE_KEY, error, form }), status);

  const ip = clientIp(c);
  if (ip && !(await rateLimit(c.env.DB, `otp-ip:${ip}`, 20, 3600))) return render("tooMany", 429);

  const email = normalizeEmail(form.email);
  if (!email) return render("invalidEmail", 400);
  if (!form.first || !form.last || form.first.length > 80 || form.last.length > 80) return render("invalidName", 400);
  if (!(await verifyTurnstile(c.env, c.req.url, String(body["cf-turnstile-response"] ?? ""), ip))) {
    return render("turnstileFailed", 400);
  }
  if (isInternalEmail(c.env, email)) return c.redirect("/login?error=use_microsoft", 303);

  await issueOtp(c.env, c.req.url, email, `${form.first} ${form.last}`, c.get("lang"));
  return c.html(otpVerifyPage(pageContext(c), email));
});

authRoutes.post("/auth/otp/verify", async (c) => {
  const body = await c.req.parseBody();
  const email = normalizeEmail(body.email);
  const code = String(body.code ?? "").trim();
  if (!email) return c.redirect("/login", 303);

  const ip = clientIp(c);
  if (ip && !(await rateLimit(c.env.DB, `otp-verify:${ip}`, 30, 900))) {
    return c.html(otpVerifyPage(pageContext(c), email, "tooMany"), 429);
  }
  const verified = /^\d{6}$/.test(code) && !isInternalEmail(c.env, email) ? await verifyOtp(c.env, email, code) : null;
  if (!verified) return c.html(otpVerifyPage(pageContext(c), email, "wrongCode"), 400);

  const db = c.env.DB;
  const existing = await db.prepare("SELECT id, status FROM users WHERE email = ?").bind(email).first<{ id: string; status: string }>();
  if (existing?.status === "blocked") return c.html(blockedPage(pageContext(c)), 403);

  let userId = existing?.id;
  if (!userId) {
    userId = crypto.randomUUID();
    await db
      .prepare("INSERT INTO users (id, email, name, user_type, lang, created_at) VALUES (?, ?, ?, 'external', ?, ?)")
      .bind(userId, email, verified.name, c.get("lang"), nowIso())
      .run();
  }
  // Un codice via email non dà mai il ruolo admin, qualunque sia l'indirizzo.
  await createSession(c, userId, "user", "otp");
  return c.redirect("/home", 303);
});

authRoutes.get("/auth/microsoft", async (c) => {
  if (!entraConfigured(c.env)) return c.redirect("/login?error=microsoft_unavailable");
  await purgeExpired(c.env.DB);
  const { url, state } = await beginLogin(c.env);
  setCookie(c, OIDC_COOKIE, state, { path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge: 600 });
  return c.redirect(url);
});

async function upsertMicrosoftUser(c: Context<AppEnv>, id: EntraIdentity): Promise<{ id: string; status: string }> {
  const db = c.env.DB;
  const found = await db
    .prepare("SELECT id, status FROM users WHERE entra_oid = ? OR email = ? ORDER BY entra_oid IS NULL LIMIT 1")
    .bind(id.oid, id.email)
    .first<{ id: string; status: string }>();
  if (found) {
    await db
      .prepare("UPDATE users SET entra_oid = ?, name = COALESCE(?, name), user_type = 'internal' WHERE id = ?")
      .bind(id.oid, id.name, found.id)
      .run();
    return found;
  }
  const userId = crypto.randomUUID();
  await db
    .prepare("INSERT INTO users (id, email, name, entra_oid, user_type, lang, created_at) VALUES (?, ?, ?, ?, 'internal', ?, ?)")
    .bind(userId, id.email, id.name, id.oid, c.get("lang"), nowIso())
    .run();
  return { id: userId, status: "active" };
}

authRoutes.get("/auth/microsoft/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const cookie = getCookie(c, OIDC_COOKIE) ?? "";
  deleteCookie(c, OIDC_COOKIE, { path: "/", secure: true });
  if (!state || !code || !safeEqual(state, cookie)) return c.redirect("/login?error=microsoft_failed");

  const identity = await completeLogin(c.env, state, code);
  if (!identity) return c.redirect("/login?error=microsoft_failed");

  const user = await upsertMicrosoftUser(c, identity);
  // Un profilo bloccato non entra; un admin conserva l'accesso al backend.
  if (user.status === "blocked" && identity.role !== "admin") return c.html(blockedPage(pageContext(c)), 403);

  await createSession(c, user.id, identity.role, "microsoft");
  if (identity.role === "admin") await audit(c.env.DB, identity.email, "admin_login");
  return c.redirect(identity.role === "admin" && user.status === "blocked" ? "/admin" : "/home");
});

authRoutes.post("/auth/logout", async (c) => {
  await destroySession(c);
  return c.redirect("/login", 303);
});

/** Solo in locale: isDev richiede DEV_MODE e un'origine localhost. Altrimenti la rotta non esiste. */
authRoutes.get("/dev/login", async (c) => {
  if (!isDev(c.env, c.req.url)) return c.notFound();
  const email = normalizeEmail(c.req.query("email")) ?? "dev@chromavis.com";
  const role = c.req.query("role") === "admin" ? "admin" : "user";
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  let userId = existing?.id;
  if (!userId) {
    userId = crypto.randomUUID();
    await c.env.DB
      .prepare("INSERT INTO users (id, email, name, user_type, lang, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(userId, email, "Dev User", isInternalEmail(c.env, email) ? "internal" : "external", c.get("lang"), nowIso())
      .run();
  }
  await createSession(c, userId, role, "dev");
  return c.redirect(role === "admin" ? "/admin" : "/home");
});
