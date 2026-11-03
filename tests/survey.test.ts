import { beforeEach, describe, expect, it } from "vitest";
import { classify, PARAMS, CLASSIFIER_VERSION } from "../src/cluster/classifier";
import { LEGAL } from "../src/privacy/consent";
import { loadAnswers, SECTIONS, toClassifierInput } from "../src/survey/answers";
import { answerIndex, QUESTIONS } from "../src/survey/definition";
import { Browser, clearOutbox, completeSurvey, confirmConsent, env, fullForm, lastCode, requestCode, sectionData, sessionAs, stubTurnstile } from "./helpers";
import { memoryOutbox } from "../src/email/sender";

const form = fullForm();
const expected = classify(
  Object.fromEntries(
    Object.entries(form).flatMap(([k, v]) => {
      if (k.startsWith("Q13.")) return [[k.slice(4), v]];
      return [[k, v]];
    })
  )
);

async function participant(email = "p@acme.com") {
  const b = new Browser();
  const id = await sessionAs(b, email);
  await confirmConsent(id);
  return { b, id };
}

async function responseOf(userId: string) {
  return env.DB.prepare("SELECT * FROM responses WHERE user_id = ?").bind(userId).first<Record<string, string>>();
}

describe("definizione del questionario", () => {
  it("contiene le 18 domande previste, con Q5 e Q6 assenti", () => {
    expect(QUESTIONS.map((q) => q.id)).toEqual([
      "Q2", "Q3", "Q4", "Q7", "Q8", "Q9", "Q10", "Q11", "Q12", "Q13", "Q14", "Q15", "Q16", "Q17", "Q18", "Q19", "Q20", "Q21"
    ]);
  });

  it("i testi e i codici coincidono con il JSON del classificatore, in EN e IT", () => {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const sources: Record<string, { en: string; it: string; opzioni: Record<string, { en: string; it: string }> }> = {
      ...(PARAMS.intensita.domande as unknown as typeof sources),
      ...(PARAMS.scelte_multiple as unknown as typeof sources)
    };
    for (const [id, source] of Object.entries(sources)) {
      const q = QUESTIONS.find((x) => x.id === id);
      if (q?.type !== "single" && q?.type !== "multi") throw new Error(id);
      expect(q.options.map((o) => String(o.code)).sort()).toEqual(Object.keys(source.opzioni).sort());
      for (const o of q.options) {
        expect(norm(o.en)).toBe(norm(source.opzioni[String(o.code)]!.en));
        expect(norm(o.it)).toBe(norm(source.opzioni[String(o.code)]!.it));
      }
    }
    const grid = QUESTIONS.find((x) => x.id === "Q13");
    if (grid?.type !== "grid") throw new Error("Q13");
    const items = PARAMS.griglia.item as unknown as Record<string, { en: string; it: string }>;
    for (const item of grid.items) {
      if (item.code === "TRAP") continue;
      expect(norm(item.it)).toBe(norm(items[item.code]!.it));
      expect(norm(item.en)).toBe(norm(items[item.code]!.en));
    }
    expect(grid.items.map((i) => i.code)).toContain("TRAP");
  });

  it("l'indice della risposta è stabile", () => {
    expect(answerIndex("Q12", 1)).toBe("12.a");
    expect(answerIndex("Q12", 3)).toBe("12.c");
    expect(answerIndex("Q13", 2, "A1")).toBe("13.A1.b");
  });

  it("la casella privacy riporta il testo fornito dal legal", () => {
    expect(LEGAL.consent.startsWith("I confirm that I have read and understood this Privacy Notice")).toBe(true);
    expect(LEGAL.consent.endsWith("the legal basis described in the Privacy Notice.")).toBe(true);
    expect(LEGAL.consent).toHaveLength(493);
  });
});

describe("privacy", () => {
  it("senza conferma il questionario non si apre", async () => {
    const b = new Browser();
    await sessionAs(b, "n@acme.com");
    expect((await b.get("/survey")).headers.get("Location")).toBe("/consent");
    expect((await b.post("/survey/section", sectionData(0, form))).headers.get("Location")).toBe("/consent");
    expect((await b.post("/survey/save", sectionData(0, form))).headers.get("Location")).toBe("/consent");
    expect((await b.get("/result")).headers.get("Location")).toBe("/consent");
  });

  it("la casella è obbligatoria e la conferma viene registrata", async () => {
    const b = new Browser();
    const id = await sessionAs(b, "n@acme.com");
    expect((await b.post("/consent", {})).status).toBe(400);
    expect((await b.post("/consent", { confirm: "1" })).headers.get("Location")).toBe("/survey");
    const event = await env.DB.prepare("SELECT action, notice_version, source FROM consent_events WHERE user_id = ?").bind(id).first();
    expect(event).toEqual({ action: "confirm", notice_version: LEGAL.version, source: "platform" });
    expect((await b.get("/survey")).status).toBe(200);
  });

  it("l'informativa resta in inglese anche con il sito in italiano", async () => {
    const b = new Browser();
    await sessionAs(b, "n@acme.com");
    await b.post("/lang", { lang: "it" });
    const text = await (await b.get("/consent")).text();
    expect(text).toContain("I confirm that I have read");
    expect(text).toContain('<html lang="it"');
  });

  it("una nuova versione dell'informativa richiede una nuova conferma", async () => {
    const b = new Browser();
    const id = await sessionAs(b, "n@acme.com");
    await env.DB
      .prepare("INSERT INTO consent_events (user_id, action, notice_version, language, source, occurred_at) VALUES (?, 'confirm', 'vecchia', 'en', 'platform', '2026')")
      .bind(id)
      .run();
    expect((await b.get("/survey")).headers.get("Location")).toBe("/consent");
  });

  it("il registro non si può modificare né cancellare", async () => {
    const { id } = await participant();
    await expect(env.DB.prepare("UPDATE consent_events SET action = 'revoke' WHERE user_id = ?").bind(id).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM consent_events WHERE user_id = ?").bind(id).run()).rejects.toThrow(/append-only/);
  });

  it("la revoca blocca, chiude le sessioni, blocca OTP ed esce dai report; lo sblocco richiede nuova conferma", async () => {
    const restore = stubTurnstile();
    clearOutbox();
    const { b, id } = await participant("r@acme.com");
    await completeSurvey(b);

    const admin = new Browser();
    await sessionAs(admin, "admin@chromavis.com", "admin", "internal");
    const before = await (await admin.get("/admin/export.csv")).text();
    expect(before).toContain(expected.cluster);

    expect((await b.post("/profile/revoke", {})).status).toBe(400);
    expect((await b.post("/profile/revoke", { confirm: "1" })).headers.get("Location")).toBe("/blocked");
    expect(await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(id).first()).toEqual({ status: "blocked" });
    expect((await b.get("/home")).headers.get("Location")).toBe("/login");

    const fresh = new Browser();
    await requestCode(fresh, "r@acme.com");
    expect(memoryOutbox[memoryOutbox.length - 1]!.subject).toMatch(/blocked|bloccato/);
    expect(lastCode()).toBe("");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM otp_codes").first()).toEqual({ n: 0 });

    const after = await (await admin.get("/admin/export.csv")).text();
    expect(after.trim().split("\r\n")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM answers").first<{ n: number }>()).not.toEqual({ n: 0 });

    expect((await admin.post(`/admin/users/${id}/unblock`)).status).toBe(303);
    const again = new Browser();
    await requestCode(again, "r@acme.com");
    await again.post("/auth/otp/verify", { email: "r@acme.com", code: lastCode() });
    expect((await again.get("/result")).headers.get("Location")).toBe("/consent");
    restore();
  });
});

describe("compilazione", () => {
  it("percorso completo: risposte in codici, cluster e output salvati", async () => {
    const { b, id } = await participant();
    expect((await b.get("/survey")).status).toBe(200);
    const res = await completeSurvey(b);
    expect(res.headers.get("Location")).toBe("/result");

    const response = await responseOf(id);
    expect(response!.status).toBe("completed");
    const rows = await loadAnswers(env.DB, response!.id!);
    expect(rows.filter((r) => r.question_id !== "Q2").every((r) => r.text_value === null)).toBe(true);

    const stored = await env.DB.prepare("SELECT * FROM cluster_results WHERE response_id = ?").bind(response!.id).first<Record<string, string | number>>();
    expect(stored!.classifier_version).toBe(CLASSIFIER_VERSION);
    expect(stored!.cluster).toBe(expected.cluster);
    expect(stored!.cluster_2).toBe(expected.cluster2);
    expect(stored!.confidence).toBe(expected.confidence);
    expect(stored!.margin).toBeCloseTo(expected.margin, 6);
    expect(JSON.parse(stored!.scores_json as string)).toEqual(expected.scores);
    expect(classify(toClassifierInput(rows)).cluster).toBe(expected.cluster);
  });

  it("cambiando lingua a metà, codici e cluster restano identici", async () => {
    const a = await participant("a@acme.com");
    await completeSurvey(a.b);

    const it2 = await participant("b@acme.com");
    await it2.b.post("/survey/section", sectionData(0, form));
    await it2.b.post("/lang", { lang: "it" });
    const page = await (await it2.b.get("/survey?s=1")).text();
    expect(page).toContain("Con quale frequenza ti trucchi?");
    const first = await (await it2.b.get("/survey?s=0")).text();
    expect(first).toMatch(/name="Q3" value="3"\s+checked/);
    for (let i = 1; i < SECTIONS.length; i++) {
      if (i === 3) await it2.b.post("/lang", { lang: "en" });
      await it2.b.post("/survey/section", sectionData(i, form));
    }

    const ra = await responseOf(a.id);
    const rb = await responseOf(it2.id);
    const simplify = (rows: Awaited<ReturnType<typeof loadAnswers>>) =>
      rows.map((r) => `${r.question_id}|${r.item_code}|${r.option_code}|${r.text_value}`).sort();
    expect(simplify(await loadAnswers(env.DB, rb!.id!))).toEqual(simplify(await loadAnswers(env.DB, ra!.id!)));
    const cluster = (id: string) => env.DB.prepare("SELECT cluster, scores_json FROM cluster_results WHERE response_id = ?").bind(id).first();
    expect(await cluster(rb!.id!)).toEqual(await cluster(ra!.id!));
  });

  it("il cambio lingua torna sulla stessa sezione, anche se è già completa", async () => {
    const { b } = await participant();
    await b.post("/survey/section", sectionData(0, form));
    expect(await (await b.get("/survey?s=0")).text()).toContain('name="next" value="/survey?s=0"');
  });

  it("il salvataggio automatico conserva le risposte parziali", async () => {
    const { b, id } = await participant();
    await b.get("/survey");
    const res = await b.post("/survey/save", { section: "0", Q3: "2" });
    expect(res.status).toBe(200);
    const response = await responseOf(id);
    const rows = await loadAnswers(env.DB, response!.id!);
    expect(rows.find((r) => r.question_id === "Q3")!.option_code).toBe(2);
    expect(await (await b.get("/survey?s=0")).text()).toMatch(/name="Q3" value="2"\s+checked/);
  });

  it("Q2 parte dal nome del login", async () => {
    const { b } = await participant();
    expect(await (await b.get("/survey?s=0")).text()).toContain('value="Test User"');
  });

  it.each([
    ["più di 3 risposte", 1, { Q12: ["1", "2", "3", "4"] }],
    ["None insieme ad altre", 1, { Q12: ["1", "11"] }],
    ["codice inesistente", 0, { Q3: "99" }],
    ["due risposte a una domanda singola", 0, { Q3: ["1", "2"] }]
  ])("rifiuta: %s", async (_name, index, overrides) => {
    const { b } = await participant();
    await b.get("/survey");
    expect((await b.post("/survey/section", sectionData(index, fullForm(overrides)))).status).toBe(400);
    expect((await b.post("/survey/save", sectionData(index, fullForm(overrides)))).status).toBe(400);
  });

  it("tutte le domande sono obbligatorie, anche ogni riga della griglia", async () => {
    const { b } = await participant();
    await b.get("/survey");
    const partial = sectionData(0, form);
    delete partial.Q4;
    const res = await b.post("/survey/section", partial);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("alert-inline");

    const grid = sectionData(2, form);
    delete grid["Q13.A7"];
    expect((await b.post("/survey/section", grid)).status).toBe(400);
    const noTrap = sectionData(2, form);
    delete noTrap["Q13.TRAP"];
    expect((await b.post("/survey/section", noTrap)).status).toBe(400);
  });

  it("non si conclude se una sezione precedente è incompleta", async () => {
    const { b, id } = await participant();
    await b.get("/survey");
    const res = await b.post("/survey/section", sectionData(SECTIONS.length - 1, form));
    expect(res.headers.get("Location")).toBe("/survey?s=0");
    expect((await responseOf(id))!.status).toBe("in_progress");
  });

  it("trappola sbagliata: classificato, segnalato, non escluso", async () => {
    const { b, id } = await participant();
    await completeSurvey(b, fullForm({ "Q13.TRAP": "3" }));
    const response = await responseOf(id);
    const stored = await env.DB.prepare("SELECT cluster, flags_json FROM cluster_results WHERE response_id = ?").bind(response!.id).first<{ cluster: string; flags_json: string }>();
    expect(stored!.cluster).toBe(expected.cluster);
    expect(JSON.parse(stored!.flags_json)).toContain("trap_fallita");
    expect(await env.DB.prepare("SELECT flag, status FROM review_flags").first()).toEqual({ flag: "trap_fallita", status: "open" });
    expect(response!.excluded_at).toBeNull();
    expect((await b.get("/result")).status).toBe(200);
  });

  it("una sola compilazione per utente", async () => {
    const { b, id } = await participant();
    await completeSurvey(b);
    expect((await b.get("/survey")).headers.get("Location")).toBe("/result");
    expect((await b.post("/survey/section", sectionData(0, form))).headers.get("Location")).toBe("/result");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM responses WHERE user_id = ?").bind(id).first()).toEqual({ n: 1 });
  });
});

describe("pagina risultato", () => {
  async function withCluster(code: string, second: string, confidence = "Netta") {
    const { b, id } = await participant(`${code}@acme.com`);
    await completeSurvey(b);
    const response = await responseOf(id);
    const rest = PARAMS.cluster.map((c) => c.codice).filter((c) => c !== code && c !== second);
    const affinities = { [code]: 0.5, [second]: 0.2, ...Object.fromEntries(rest.map((c) => [c, 0.06])) };
    await env.DB
      .prepare("UPDATE cluster_results SET cluster = ?, cluster_2 = ?, confidence = ?, affinities_json = ? WHERE response_id = ?")
      .bind(code, second, confidence, JSON.stringify(affinities), response!.id)
      .run();
    return b;
  }

  const ADMIN_ONLY = ["blacklist", "Market relevance", "Estimated", "Demographics", "per person", "Outlining", "Heavy users"];

  it.each(PARAMS.cluster.map((c) => [c.codice, c.nome] as const))("%s mostra nome e definizioni, senza parti riservate", async (code, name) => {
    const other = code === "BTP" ? "BEE" : "BTP";
    const b = await withCluster(code, other);
    const res = await b.get("/result");
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const word of name.split(" ")) expect(text).toContain(word);
    expect(text).toContain("affinity-row is-main");
    for (const secret of ADMIN_ONLY) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/\sstyle=/);
  });

  it("le affinità mostrate sommano a 100%", async () => {
    const { b } = await participant();
    await completeSurvey(b);
    const text = await (await b.get("/result")).text();
    const shares = [...text.matchAll(/affinity-value">([\d.]+)%/g)].map((m) => Number(m[1]));
    expect(shares).toHaveLength(7);
    const sum = shares.reduce((a, c) => a + c, 0);
    expect(Math.abs(sum - 100)).toBeLessThan(1.5);
  });

  it("con confidenza Incerta dice che il profilo è vicino a due cluster", async () => {
    const b = await withCluster("BTP", "HER", "Incerta");
    const text = await (await b.get("/result")).text();
    expect(text).toContain("sit between two clusters");
    expect(text).toContain("Hero Believers");
  });

  it("è disponibile in italiano", async () => {
    const b = await withCluster("BTP", "HER");
    await b.post("/lang", { lang: "it" });
    expect(await (await b.get("/result")).text()).toContain("Il make-up è il tuo terreno di gioco.");
  });
});

describe("report ed export admin", () => {
  it("report, filtri, CSV con indici e codici, audit, esclusione in revisione", async () => {
    const internal = new Browser();
    const internalId = await sessionAs(internal, "i@chromavis.com", "user", "internal");
    await confirmConsent(internalId);
    await completeSurvey(internal);
    const external = await participant("e@acme.com");
    await completeSurvey(external.b, fullForm({ "Q13.TRAP": "2", Q4: "2" }));

    const admin = new Browser();
    await sessionAs(admin, "admin@chromavis.com", "admin", "internal");

    const all = await (await admin.get("/admin")).text();
    expect(all).toContain('kpi-value">2<');
    expect(all).toContain("12.a");
    expect(all).toContain("Distribuzione dei cluster");

    const onlyExternal = await (await admin.get("/admin?origin=external")).text();
    expect(onlyExternal).toMatch(/kpi-value">1<\/span><span class="kpi-label">Completati/);
    const area = await (await admin.get("/admin?area=2")).text();
    expect(area).toMatch(/kpi-value">1<\/span><span class="kpi-label">Completati/);

    const res = await admin.get("/admin/export.csv");
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const csv = (await res.text()).replace(/^﻿/, "");
    const [header, ...rows] = csv.trim().split("\r\n");
    expect(rows).toHaveLength(2);
    expect(header).toContain("Q12_index,Q12_code");
    expect(header).toContain("Q13_A1_index,Q13_A1_code");
    expect(csv).toContain('"12.a;12.b;12.h","1;2;8"');
    expect(csv).toContain("13.A1.a");
    expect(csv).not.toContain("acme.com");
    expect(csv).not.toContain("chromavis.com");
    expect(csv).not.toContain("Test User");
    expect(await env.DB.prepare("SELECT action FROM audit_log WHERE action = 'export_csv'").first()).toEqual({ action: "export_csv" });

    const flag = await env.DB.prepare("SELECT id FROM review_flags WHERE flag = 'trap_fallita'").first<{ id: number }>();
    expect(await (await admin.get("/admin/review")).text()).toContain("Domanda trappola sbagliata");
    await admin.post(`/admin/review/${flag!.id}`, { action: "exclude" });
    const excluded = (await (await admin.get("/admin/export.csv")).text()).trim().split("\r\n");
    expect(excluded).toHaveLength(2);
    expect((await external.b.get("/result")).status).toBe(200);

    await admin.post(`/admin/review/${flag!.id}`, { action: "reopen" });
    expect((await (await admin.get("/admin/export.csv")).text()).trim().split("\r\n")).toHaveLength(3);
  });

  it("la pagina definizioni riservate è per gli admin", async () => {
    const admin = new Browser();
    await sessionAs(admin, "admin@chromavis.com", "admin", "internal");
    const text = await (await admin.get("/admin/clusters")).text();
    expect(text).toContain("Market relevance");
    expect(text).toContain("Mainstream Conscious");
    expect(text).not.toContain("Consciuos");
  });

  it("calcola i cluster delle risposte importate senza risultato", async () => {
    const { b, id } = await participant();
    await completeSurvey(b);
    const response = await responseOf(id);
    await env.DB.prepare("DELETE FROM cluster_results WHERE response_id = ?").bind(response!.id).run();
    const admin = new Browser();
    await sessionAs(admin, "admin@chromavis.com", "admin", "internal");
    expect(await (await admin.get("/admin")).text()).toContain("Calcola i cluster");
    expect((await admin.post("/admin/recalculate")).headers.get("Location")).toBe("/admin?recalc=1-0");
    expect(await env.DB.prepare("SELECT cluster FROM cluster_results WHERE response_id = ?").bind(response!.id).first()).toEqual({ cluster: expected.cluster });
  });
});

beforeEach(() => clearOutbox());
