import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

/** Dipendenze esterne, sostituibili nei test. */
export const deps: {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  jwks: (tenantId: string) => JWTVerifyGetKey;
} = {
  fetch: (url, init) => fetch(url, init),
  jwks: (tenantId) =>
    createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`))
};
