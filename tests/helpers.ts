import { env as rawEnv } from "cloudflare:workers";
import type { Env } from "../src/env";
import { memoryOutbox } from "../src/email/sender";
import { handle } from "../src/index";
import { deps } from "../src/deps";
import { recordConsent } from "../src/privacy/consent";
import { SECTIONS } from "../src/survey/answers";
import { nowIso } from "../src/lib";

export const env = rawEnv as unknown as Env;
export const ORIGIN = "https://survey.test";

export class Browser {
  cookies = new Map<string, string>();
  constructor(private readonly e: Env = env) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.method && init.method !== "GET" && !headers.has("Origin")) headers.set("Origin", ORIGIN);
    const res = await handle(new Request(ORIGIN + path, { ...init, headers, redirect: "manual" }), this.e);
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, ...value] = pair!.split("=");
      const joined = value.join("=");
      if (/Max-Age=0/i.test(cookie) || joined === "") this.cookies.delete(name!);
      else this.cookies.set(name!, joined);
    }
    return res;
  }

  get(path: string) {
    return this.request(path);
  }

  post(path: string, data: Record<string, string | string[]> = {}, init: RequestInit = {}) {
    const body = new FormData();
    for (const [key, value] of Object.entries(data)) {
      for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
    }
    return this.request(path, { method: "POST", body, ...init });
  }
}

export function stubTurnstile(ok = true) {
  const original = deps.fetch;
  deps.fetch = async (url, init) => {
    if (url.includes("turnstile")) return Response.json({ success: ok });
    return original(url, init);
  };
  return () => { deps.fetch = original; };
}

export function clearOutbox() {
  memoryOutbox.length = 0;
}

export function lastCode(): string {
  const mail = memoryOutbox[memoryOutbox.length - 1];
  return /\b(\d{6})\b/.exec(mail?.text ?? "")?.[1] ?? "";
}

export const requestCode = (b: Browser, email: string) =>
  b.post("/auth/otp/request", { first: "Ada", last: "Rossi", email, "cf-turnstile-response": "ok" });

/** Login completo con OTP, come un utente esterno. */
export async function otpLogin(b: Browser, email: string) {
  await requestCode(b, email);
  return b.post("/auth/otp/verify", { email, code: lastCode() });
}

/** Crea una sessione diretta con il ruolo indicato, per i test che non riguardano il login. */
export async function sessionAs(b: Browser, email: string, role: "admin" | "user" = "user", userType: "internal" | "external" = "external") {
  const id = crypto.randomUUID();
  const token = `token-${id}`;
  const { sha256Hex, addMinutes } = await import("../src/lib");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, name, user_type, created_at) VALUES (?, ?, 'Test User', ?, ?)").bind(id, email, userType, nowIso()),
    env.DB
      .prepare("INSERT INTO sessions (token_hash, user_id, role, auth_method, created_at, expires_at) VALUES (?, ?, ?, 'otp', ?, ?)")
      .bind(await sha256Hex(token), id, role, nowIso(), addMinutes(60))
  ]);
  b.cookies.set("__Host-cs_session", token);
  return id;
}

export const confirmConsent = (userId: string) => recordConsent(env.DB, userId, "confirm", "en", "platform").run();

/** Risposte complete, nel formato del modulo, a partire da una riga del classificatore. */
export function fullForm(overrides: Record<string, string | string[]> = {}): Record<string, string | string[]> {
  const base: Record<string, string | string[]> = {
    Q2: "Test User", Q3: "3", Q4: "1", Q7: "5", Q8: "3",
    Q9: "1", Q10: "4", Q11: "3", Q12: ["1", "2", "8"],
    "Q13.TRAP": "1",
    Q14: ["1", "3", "12"], Q15: ["2", "5", "13"], Q16: ["5", "6"], Q17: ["2", "6"],
    Q18: "3", Q19: "3", Q20: "3", Q21: ["2", "10"]
  };
  const grid = [1, 1, 2, 5, 4, 4, 4, 3, 2, 2, 2, 2, 3, 3, 3, 3, 3, 2];
  grid.forEach((v, i) => { base[`Q13.A${i + 1}`] = String(v); });
  return { ...base, ...overrides };
}

export function sectionData(index: number, form: Record<string, string | string[]>) {
  const section = SECTIONS[index]!;
  const data: Record<string, string | string[]> = { section: String(index) };
  for (const q of section.questions) {
    for (const [key, value] of Object.entries(form)) {
      if (key === q.id || key.startsWith(`${q.id}.`)) data[key] = value;
    }
  }
  return data;
}

export async function completeSurvey(b: Browser, form = fullForm()) {
  let last: Response | undefined;
  for (let i = 0; i < SECTIONS.length; i++) last = await b.post("/survey/section", sectionData(i, form));
  return last!;
}
