import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deps } from "../src/deps";
import { memoryOutbox } from "../src/email/sender";
import { handle } from "../src/index";
import { Browser, clearOutbox, env, lastCode, otpLogin, requestCode, sessionAs, stubTurnstile } from "./helpers";

let restore: () => void;
beforeEach(() => { restore = stubTurnstile(); clearOutbox(); });
afterEach(() => restore());

describe("OTP", () => {
  it("accesso riuscito: crea un utente esterno con ruolo user", async () => {
    const b = new Browser();
    const res = await otpLogin(b, "cliente@acme.com");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/home");
    const user = await env.DB.prepare("SELECT user_type, name FROM users WHERE email = ?").bind("cliente@acme.com").first();
    expect(user).toEqual({ user_type: "external", name: "Ada Rossi" });
    const session = await env.DB.prepare("SELECT role, auth_method FROM sessions").first();
    expect(session).toEqual({ role: "user", auth_method: "otp" });
  });

  it("accetta qualunque email esterna", async () => {
    for (const email of ["a@fareva.com", "b@cliente-qualsiasi.it"]) {
      expect((await otpLogin(new Browser(), email)).status).toBe(303);
    }
  });

  it("il codice salvato non è in chiaro", async () => {
    await requestCode(new Browser(), "c@acme.com");
    const row = await env.DB.prepare("SELECT code_hmac FROM otp_codes").first<{ code_hmac: string }>();
    expect(row!.code_hmac).not.toContain(lastCode());
    expect(row!.code_hmac).toHaveLength(64);
  });

  it("scade dopo dieci minuti", async () => {
    const b = new Browser();
    await requestCode(b, "c@acme.com");
    const row = await env.DB.prepare("SELECT created_at, expires_at FROM otp_codes").first<{ created_at: string; expires_at: string }>();
    expect(Date.parse(row!.expires_at) - Date.parse(row!.created_at)).toBeLessThanOrEqual(600_000 + 1000);
    await env.DB.prepare("UPDATE otp_codes SET expires_at = ?").bind("2000-01-01T00:00:00.000Z").run();
    expect((await b.post("/auth/otp/verify", { email: "c@acme.com", code: lastCode() })).status).toBe(400);
  });

  it("è monouso", async () => {
    const b = new Browser();
    await requestCode(b, "c@acme.com");
    const code = lastCode();
    expect((await b.post("/auth/otp/verify", { email: "c@acme.com", code })).status).toBe(303);
    expect((await new Browser().post("/auth/otp/verify", { email: "c@acme.com", code })).status).toBe(400);
  });

  it("dopo 5 tentativi errati rifiuta anche il codice giusto", async () => {
    const b = new Browser();
    await requestCode(b, "c@acme.com");
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await b.post("/auth/otp/verify", { email: "c@acme.com", code: wrong })).status).toBe(400);
    expect((await b.post("/auth/otp/verify", { email: "c@acme.com", code })).status).toBe(400);
  });

  it("un nuovo codice annulla il precedente", async () => {
    const b = new Browser();
    await requestCode(b, "c@acme.com");
    const old = lastCode();
    await requestCode(b, "c@acme.com");
    if (old !== lastCode()) expect((await b.post("/auth/otp/verify", { email: "c@acme.com", code: old })).status).toBe(400);
    expect((await b.post("/auth/otp/verify", { email: "c@acme.com", code: lastCode() })).status).toBe(303);
  });

  it("gli indirizzi @chromavis.com vanno al login Microsoft", async () => {
    const res = await requestCode(new Browser(), "persona@chromavis.com");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toContain("use_microsoft");
    expect(memoryOutbox).toHaveLength(0);
  });

  it("rifiuta se Turnstile fallisce e non invia nulla", async () => {
    restore();
    restore = stubTurnstile(false);
    expect((await requestCode(new Browser(), "c@acme.com")).status).toBe(400);
    expect(memoryOutbox).toHaveLength(0);
  });

  it("risposta identica per indirizzo nuovo, esistente e bloccato", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, user_type, created_at) VALUES ('u1', 'esiste@acme.com', 'external', '2026')"),
      env.DB.prepare("INSERT INTO users (id, email, user_type, status, created_at) VALUES ('u2', 'bloccato@acme.com', 'external', 'blocked', '2026')")
    ]);
    const normalize = (text: string, email: string) => text.replace(email, "X");
    const pages = await Promise.all(
      ["nuovo@acme.com", "esiste@acme.com", "bloccato@acme.com"].map(async (email) => {
        const res = await requestCode(new Browser(), email);
        return { status: res.status, text: normalize(await res.text(), email) };
      })
    );
    expect(pages[0]).toEqual(pages[1]);
    expect(pages[0]).toEqual(pages[2]);
  });

  it("limita le richieste per email", async () => {
    const b = new Browser();
    for (let i = 0; i < 6; i++) await requestCode(b, "c@acme.com");
    expect(memoryOutbox).toHaveLength(5);
  });

  it("un OTP non dà mai il ruolo admin, anche con l'email in ADMIN_EMAILS", async () => {
    const e = { ...env, ADMIN_EMAILS: "esterno@acme.com" };
    const b = new Browser(e);
    await otpLogin(b, "esterno@acme.com");
    expect((await b.get("/admin")).status).toBe(403);
  });
});

describe("Microsoft", () => {
  const TENANT = "tenant-test";
  const CLIENT = "client-test";
  let privateKey: CryptoKey;
  let claims: Record<string, unknown>;
  const original = { fetch: deps.fetch, jwks: deps.jwks };

  beforeEach(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateKey = pair.privateKey as CryptoKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
    deps.jwks = () => createLocalJWKSet({ keys: [jwk] });
    claims = { tid: TENANT, oid: "oid-1", email: "Persona@chromavis.com", name: "Persona Interna", groups: [] };
    deps.fetch = async (url) => {
      if (!url.includes("/oauth2/v2.0/token")) throw new Error(`fetch inatteso: ${url}`);
      const nonce = (claims.nonce as string) ?? currentNonce;
      const token = await new SignJWT({ ...claims, nonce })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer((claims.iss as string) ?? `https://login.microsoftonline.com/${TENANT}/v2.0`)
        .setAudience((claims.aud as string) ?? CLIENT)
        .setExpirationTime("5m")
        .setIssuedAt()
        .sign(privateKey);
      return Response.json({ id_token: token });
    };
  });
  afterEach(() => { deps.fetch = original.fetch; deps.jwks = original.jwks; });

  let currentNonce = "";
  async function login(b: Browser, code = "abc") {
    const start = await b.get("/auth/microsoft");
    expect(start.status).toBe(302);
    const url = new URL(start.headers.get("Location")!);
    expect(url.hostname).toBe("login.microsoftonline.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    currentNonce = url.searchParams.get("nonce")!;
    return b.get(`/auth/microsoft/callback?state=${url.searchParams.get("state")}&code=${code}`);
  }

  it("membro del gruppo: admin", async () => {
    claims.groups = ["group-admin"];
    const b = new Browser();
    expect((await login(b)).status).toBe(302);
    expect((await b.get("/admin")).status).toBe(200);
    const user = await env.DB.prepare("SELECT email, user_type FROM users").first();
    expect(user).toEqual({ email: "persona@chromavis.com", user_type: "internal" });
  });

  it("non membro del gruppo: utente normale", async () => {
    const b = new Browser();
    await login(b);
    expect((await b.get("/home")).status).toBe(200);
    expect((await b.get("/admin")).status).toBe(403);
  });

  it("ADMIN_EMAILS vale per il login Microsoft", async () => {
    const b = new Browser({ ...env, ADMIN_EMAILS: "persona@chromavis.com" });
    await login(b);
    expect((await b.get("/admin")).status).toBe(200);
  });

  it("il placeholder del gruppo non dà a nessuno il ruolo admin", async () => {
    claims.groups = ["PLACEHOLDER_ADMIN_GROUP"];
    const b = new Browser({ ...env, ENTRA_ADMIN_GROUP_ID: "PLACEHOLDER_ADMIN_GROUP" });
    await login(b);
    expect((await b.get("/admin")).status).toBe(403);
  });

  it.each([
    ["nonce sbagliato", { nonce: "altro" }],
    ["tenant sbagliato", { tid: "altro-tenant" }],
    ["emittente sbagliato", { iss: "https://evil.example/v2.0" }],
    ["destinatario sbagliato", { aud: "altro-client" }]
  ])("rifiuta: %s", async (_name, override) => {
    Object.assign(claims, override);
    const b = new Browser();
    const res = await login(b);
    expect(res.headers.get("Location")).toContain("microsoft_failed");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).toEqual({ n: 0 });
  });

  it("rifiuta uno state diverso dal cookie e lo state riusato", async () => {
    const b = new Browser();
    const res = await b.get("/auth/microsoft/callback?state=falso&code=abc");
    expect(res.headers.get("Location")).toContain("microsoft_failed");

    const start = await b.get("/auth/microsoft");
    const url = new URL(start.headers.get("Location")!);
    currentNonce = url.searchParams.get("nonce")!;
    const callback = `/auth/microsoft/callback?state=${url.searchParams.get("state")}&code=abc`;
    const stateCookie = b.cookies.get("__Host-cs_oidc")!;
    expect((await b.get(callback)).headers.get("Location")).toBe("/home");
    b.cookies.set("__Host-cs_oidc", stateCookie);
    expect((await b.get(callback)).headers.get("Location")).toContain("microsoft_failed");
  });

  it("collega il login all'utente importato dal pilota", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, user_type, created_at) VALUES ('pilot', 'persona@chromavis.com', 'internal', '2026')").run();
    await login(new Browser());
    const row = await env.DB.prepare("SELECT id, entra_oid FROM users").first();
    expect(row).toEqual({ id: "pilot", entra_oid: "oid-1" });
  });

  it("un profilo bloccato non entra, un admin bloccato conserva il backend", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, user_type, status, created_at) VALUES ('b', 'persona@chromavis.com', 'internal', 'blocked', '2026')").run();
    expect((await login(new Browser())).status).toBe(403);
    claims.groups = ["group-admin"];
    const admin = new Browser();
    expect((await login(admin)).headers.get("Location")).toBe("/admin");
    expect((await admin.get("/admin")).status).toBe(200);
    expect((await admin.get("/survey")).headers.get("Location")).toBe("/blocked");
  });
});

describe("Sicurezza generale", () => {
  it("POST senza Origin o da un altro sito viene rifiutata", async () => {
    const b = new Browser();
    expect((await b.post("/auth/logout", {}, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    const noOrigin = await handle(new Request("https://survey.test/lang", { method: "POST" }), env);
    expect(noOrigin.status).toBe(403);
  });

  it("gli header di sicurezza ci sono su pagine, file statici e 404", async () => {
    const b = new Browser();
    for (const path of ["/login", "/app.css", "/non-esiste"]) {
      const res = await b.get(path);
      const csp = res.headers.get("Content-Security-Policy")!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
      expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Strict-Transport-Security")).toContain("max-age");
    }
  });

  it("le pagine non contengono script o stili inline", async () => {
    const text = await (await new Browser().get("/login")).text();
    expect(text).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(text).not.toMatch(/\sstyle=/);
    expect(text).not.toMatch(/\son[a-z]+=/);
  });

  it("il cookie di sessione è protetto", async () => {
    await requestCode(new Browser(), "c@acme.com");
    const res = await new Browser().post("/auth/otp/verify", { email: "c@acme.com", code: lastCode() });
    const cookie = res.headers.getSetCookie().find((v) => v.startsWith("__Host-cs_session"))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it("le rotte admin sono negate agli utenti e agli anonimi", async () => {
    const paths = ["/admin", "/admin/review", "/admin/users", "/admin/clusters", "/admin/export.csv"];
    const user = new Browser();
    await sessionAs(user, "u@acme.com");
    for (const path of paths) {
      expect((await user.get(path)).status).toBe(403);
      expect((await new Browser().get(path)).status).toBe(302);
    }
    expect((await user.post("/admin/recalculate")).status).toBe(403);
    expect((await user.post("/admin/users/x/unblock")).status).toBe(403);
  });

  it("la scorciatoia di sviluppo non esiste fuori dal locale", async () => {
    expect((await new Browser().get("/dev/login?role=admin")).status).toBe(404);
    const devOnPublic = new Browser({ ...env, DEV_MODE: "true" });
    expect((await devOnPublic.get("/dev/login?role=admin")).status).toBe(404);
  });

  it("il redirect dopo il cambio lingua resta sul sito", async () => {
    const res = await new Browser().post("/lang", { lang: "it", next: "//evil.example" });
    expect(res.headers.get("Location")).toBe("/");
  });
});
