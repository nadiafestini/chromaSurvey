export interface EmailBinding {
  send(message: { to: string; from: string; subject: string; text: string; html?: string }): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  EMAIL?: EmailBinding;
  APP_ORIGIN: string;
  ENTRA_TENANT_ID: string;
  ENTRA_CLIENT_ID: string;
  ENTRA_CLIENT_SECRET?: string;
  ENTRA_ADMIN_GROUP_ID: string;
  ADMIN_EMAILS: string;
  INTERNAL_DOMAINS: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY?: string;
  EMAIL_FROM: string;
  EMAIL_PROVIDER: string;
  OTP_PEPPER?: string;
  DEV_MODE?: string;
}

export type Lang = "en" | "it";
export type Theme = "dark" | "light";
export type Role = "admin" | "user";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  status: "active" | "blocked";
  userType: "internal" | "external";
  role: Role;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser | null; lang: Lang; theme: Theme };
};

/** Scorciatoie di sviluppo attive solo in locale: mai su un'origine pubblica. */
export function isDev(env: Env, requestUrl: string): boolean {
  if (env.DEV_MODE !== "true") return false;
  const isLocal = (url: string) => ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
  return isLocal(requestUrl) && isLocal(env.APP_ORIGIN);
}
