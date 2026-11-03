import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { loadSessionUser } from "./auth/session";
import type { AppEnv, Env } from "./env";
import { pickLang } from "./i18n";
import { withSecurityHeaders } from "./middleware/security-headers";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { userRoutes } from "./routes/user";

const app = new Hono<AppEnv>();

const STATIC_PATH = /\.(css|js|png|svg|ico)$/;

/** Le richieste che modificano dati devono arrivare dal sito stesso. */
app.use("*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (origin !== c.env.APP_ORIGIN && !(origin === undefined && c.req.header("Sec-Fetch-Site") === "same-origin")) {
      return c.text("Forbidden", 403);
    }
  }
  await next();
});

app.use("*", async (c, next) => {
  if (STATIC_PATH.test(new URL(c.req.url).pathname)) {
    c.set("user", null);
    c.set("theme", "dark");
    c.set("lang", "en");
    return next();
  }
  const user = await loadSessionUser(c);
  c.set("user", user);
  c.set("theme", getCookie(c, "cs_theme") === "light" ? "light" : "dark");
  c.set("lang", pickLang(getCookie(c, "cs_lang"), c.req.header("Accept-Language")));
  await next();
});

app.route("/", authRoutes);
app.route("/", userRoutes);
app.route("/", adminRoutes);

// Tutto il resto sono file statici.
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((error, c) => {
  console.error("Errore non gestito:", error.message);
  return c.text("Internal Server Error", 500);
});

export async function handle(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const response = await app.fetch(request, env, ctx);
  return withSecurityHeaders(response, request.url);
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => handle(request, env, ctx)
};
