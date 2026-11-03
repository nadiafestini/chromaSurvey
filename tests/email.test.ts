import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deps } from "../src/deps";
import { sendEmail } from "../src/email/sender";
import type { Env } from "../src/env";
import { Browser, env, requestCode } from "./helpers";

const graphEnv: Env = {
  ...env,
  EMAIL_PROVIDER: "graph",
  EMAIL_FROM: "noreply@chromavis.com",
  GRAPH_CLIENT_ID: "graph-client",
  GRAPH_CLIENT_SECRET: "graph-secret"
};
const MAIL = { to: "cliente@acme.com", subject: "Oggetto", text: "Il tuo codice: 123456" };
const URL_BASE = "https://survey.test/";

interface Call { url: string; init?: RequestInit }

describe("invio email con Microsoft Graph", () => {
  const original = deps.fetch;
  let calls: Call[];
  let tokenResponse: () => Response;
  let sendResponse: () => Response;

  beforeEach(() => {
    calls = [];
    tokenResponse = () => Response.json({ access_token: "token-graph" });
    sendResponse = () => new Response(null, { status: 202 });
    deps.fetch = async (url, init) => {
      if (url.includes("turnstile")) return Response.json({ success: true });
      calls.push({ url, init });
      return url.includes("/oauth2/") ? tokenResponse() : sendResponse();
    };
  });
  afterEach(() => { deps.fetch = original; });

  it("chiede il token dell'app dedicata, non di quella del login", async () => {
    await sendEmail(graphEnv, URL_BASE, MAIL);
    expect(calls[0]!.url).toBe("https://login.microsoftonline.com/tenant-test/oauth2/v2.0/token");
    const body = calls[0]!.init!.body as URLSearchParams;
    expect(body.get("client_id")).toBe("graph-client");
    expect(body.get("client_secret")).toBe("graph-secret");
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("scope")).toBe("https://graph.microsoft.com/.default");
  });

  it("invia dalla casella EMAIL_FROM al destinatario, senza salvare il codice nella Posta inviata", async () => {
    await sendEmail(graphEnv, URL_BASE, MAIL);
    expect(calls[1]!.url).toBe("https://graph.microsoft.com/v1.0/users/noreply%40chromavis.com/sendMail");
    expect(new Headers(calls[1]!.init!.headers).get("Authorization")).toBe("Bearer token-graph");
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({
      message: {
        subject: "Oggetto",
        body: { contentType: "Text", content: "Il tuo codice: 123456" },
        toRecipients: [{ emailAddress: { address: "cliente@acme.com" } }]
      },
      saveToSentItems: false
    });
  });

  it("senza configurazione non chiama Microsoft", async () => {
    await expect(sendEmail({ ...graphEnv, GRAPH_CLIENT_SECRET: undefined }, URL_BASE, MAIL)).rejects.toThrow("GRAPH_CLIENT_SECRET");
    await expect(sendEmail({ ...graphEnv, GRAPH_CLIENT_ID: "PLACEHOLDER_GRAPH_CLIENT_ID" }, URL_BASE, MAIL)).rejects.toThrow("GRAPH_CLIENT_ID");
    expect(calls).toHaveLength(0);
  });

  it("segnala il rifiuto del token con il solo codice di errore", async () => {
    tokenResponse = () => Response.json({ error: "invalid_client", error_description: "dettagli riservati" }, { status: 401 });
    await expect(sendEmail(graphEnv, URL_BASE, MAIL)).rejects.toThrow(/^Token Graph non ottenuto: HTTP 401 invalid_client$/);
    expect(calls).toHaveLength(1);
  });

  it("non considera inviata una risposta diversa da 202, e l'errore non contiene indirizzi", async () => {
    sendResponse = () => Response.json({ error: { code: "ErrorAccessDenied", message: "cliente@acme.com negato" } }, { status: 403 });
    const error = await sendEmail(graphEnv, URL_BASE, MAIL).catch((e: Error) => e);
    expect((error as Error).message).toBe("Invio Graph rifiutato: HTTP 403 ErrorAccessDenied");
    sendResponse = () => new Response(null, { status: 200 });
    await expect(sendEmail(graphEnv, URL_BASE, MAIL)).rejects.toThrow("HTTP 200");
  });

  it("il codice OTP richiesto dal sito parte con Graph e non viene salvato in chiaro", async () => {
    const res = await requestCode(new Browser(graphEnv), "cliente@acme.com");
    expect(res.status).toBe(200);
    const mail = JSON.parse(calls.find((c) => c.url.includes("/sendMail"))!.init!.body as string);
    expect(mail.message.toRecipients[0].emailAddress.address).toBe("cliente@acme.com");
    const code = /\b(\d{6})\b/.exec(mail.message.body.content)![1]!;
    const row = await env.DB.prepare("SELECT code_hmac FROM otp_codes").first<{ code_hmac: string }>();
    expect(row!.code_hmac).not.toContain(code);
  });

  it("se Graph fallisce la pagina non cambia: non si scopre nulla sull'indirizzo", async () => {
    const ok = await (await requestCode(new Browser(graphEnv), "a@acme.com")).text();
    sendResponse = () => new Response(null, { status: 500 });
    const res = await requestCode(new Browser(graphEnv), "b@acme.com");
    expect(res.status).toBe(200);
    expect((await res.text()).replaceAll("b@acme.com", "a@acme.com")).toBe(ok);
  });
});
