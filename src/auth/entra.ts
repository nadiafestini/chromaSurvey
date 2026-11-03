import { jwtVerify } from "jose";
import { deps } from "../deps";
import type { Env, Role } from "../env";
import { addMinutes, base64Url, emailHasDomain, normalizeEmail, nowIso, randomToken, sha256Hex, sha256Raw } from "../lib";

const placeholder = (value: string | undefined) => !value || value.startsWith("PLACEHOLDER");

export const entraConfigured = (env: Env) =>
  !placeholder(env.ENTRA_TENANT_ID) && !placeholder(env.ENTRA_CLIENT_ID) && !!env.ENTRA_CLIENT_SECRET;

const redirectUri = (env: Env) => `${env.APP_ORIGIN}/auth/microsoft/callback`;

/** Prepara il redirect verso Microsoft con state, nonce e PKCE. */
export async function beginLogin(env: Env): Promise<{ url: string; state: string }> {
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  await env.DB
    .prepare("INSERT INTO oidc_states (state_hash, nonce, code_verifier, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(state), nonce, verifier, addMinutes(10))
    .run();
  const params = new URLSearchParams({
    client_id: env.ENTRA_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri(env),
    response_mode: "query",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: base64Url(await sha256Raw(verifier)),
    code_challenge_method: "S256"
  });
  return { url: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/authorize?${params}`, state };
}

export interface EntraIdentity {
  oid: string;
  email: string;
  name: string | null;
  role: Role;
}

export function roleFromClaims(env: Env, email: string, groups: unknown): Role {
  const groupId = env.ENTRA_ADMIN_GROUP_ID;
  if (!placeholder(groupId) && Array.isArray(groups) && groups.includes(groupId)) return "admin";
  const admins = env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return admins.includes(email) ? "admin" : "user";
}

/** Completa il login: lo state è monouso, poi verifica firma, emittente, destinatario, tenant e nonce. */
export async function completeLogin(env: Env, state: string, code: string): Promise<EntraIdentity | null> {
  const stateHash = await sha256Hex(state);
  const saved = await env.DB
    .prepare("DELETE FROM oidc_states WHERE state_hash = ? AND expires_at > ? RETURNING nonce, code_verifier")
    .bind(stateHash, nowIso())
    .first<{ nonce: string; code_verifier: string }>();
  if (!saved) return null;

  const tokenRes = await deps.fetch(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.ENTRA_CLIENT_ID,
      client_secret: env.ENTRA_CLIENT_SECRET ?? "",
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(env),
      code_verifier: saved.code_verifier
    })
  });
  if (!tokenRes.ok) return null;
  const { id_token: idToken } = (await tokenRes.json()) as { id_token?: string };
  if (!idToken) return null;

  try {
    const { payload } = await jwtVerify(idToken, deps.jwks(env.ENTRA_TENANT_ID), {
      issuer: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0`,
      audience: env.ENTRA_CLIENT_ID
    });
    if (payload.nonce !== saved.nonce || payload.tid !== env.ENTRA_TENANT_ID) return null;
    const email = normalizeEmail(payload.email ?? payload.preferred_username);
    if (!email || typeof payload.oid !== "string") return null;
    // Con troppi gruppi Entra non li mette nel token: va impostato "Groups assigned to the application".
    if (payload._claim_names) console.warn("Claim groups non presente nel token per eccesso di gruppi");
    return {
      oid: payload.oid,
      email,
      name: typeof payload.name === "string" ? payload.name : null,
      role: roleFromClaims(env, email, payload.groups)
    };
  } catch {
    return null;
  }
}

export const isInternalEmail = (env: Env, email: string) => emailHasDomain(email, env.INTERNAL_DOMAINS);
