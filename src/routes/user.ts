import { Hono, type Context, type Next } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { SESSION_COOKIE } from "../auth/session";
import { clusterStatements, loadCluster } from "../cluster/store";
import type { AppEnv, Lang } from "../env";
import { nowIso, randomToken, safeNext } from "../lib";
import { consentState, lastConsentEvent, recordConsent } from "../privacy/consent";
import {
  formToValues,
  InvalidSubmission,
  loadAnswers,
  missingQuestions,
  parseQuestions,
  rowsToValues,
  saveSectionStatements,
  SECTIONS,
  type AnswerRow
} from "../survey/answers";
import { ensureSurveyVersion, SURVEY, SURVEY_VERSION_ID } from "../survey/definition";
import { blockedPage, legalPage } from "../views/auth";
import { consentPage, homePage, profilePage, resultPage, surveyPage } from "../views/user";
import { pageContext } from "./context";

export const userRoutes = new Hono<AppEnv>();

interface ResponseRow { id: string; status: "in_progress" | "completed"; language: string }

function findResponse(c: Context<AppEnv>, userId: string) {
  return c.env.DB
    .prepare("SELECT id, status, language FROM responses WHERE user_id = ? AND survey_id = ? AND status <> 'archived'")
    .bind(userId, SURVEY.id)
    .first<ResponseRow>();
}

const requireLogin = async (c: Context<AppEnv>, next: Next) => {
  if (!c.get("user")) return c.redirect("/login");
  await next();
};

/** Le pagine di partecipazione richiedono un profilo attivo e la conferma privacy in vigore. */
const requireParticipant = async (c: Context<AppEnv>, next: Next) => {
  const user = c.get("user");
  if (!user) return c.redirect("/login");
  if (user.status === "blocked") return c.redirect("/blocked");
  if ((await consentState(c.env.DB, user.id)) !== "confirmed") return c.redirect("/consent");
  await next();
};

async function ensureResponse(c: Context<AppEnv>): Promise<ResponseRow> {
  const user = c.get("user")!;
  const existing = await findResponse(c, user.id);
  if (existing) return existing;
  await ensureSurveyVersion(c.env.DB);
  const id = crypto.randomUUID();
  const statements = [
    c.env.DB
      .prepare(
        `INSERT OR IGNORE INTO responses (id, rid, user_id, survey_id, survey_version_id, source, status, language, started_at)
         VALUES (?, ?, ?, ?, ?, 'platform', 'in_progress', ?, ?)`
      )
      .bind(id, `P-${randomToken(6)}`, user.id, SURVEY.id, SURVEY_VERSION_ID, c.get("lang"), nowIso())
  ];
  // Q2 parte dal nome del login e resta modificabile.
  if (user.name) {
    statements.push(
      c.env.DB
        .prepare("INSERT OR IGNORE INTO answers (response_id, question_id, item_code, option_code, text_value) SELECT ?, 'Q2', '', 0, ? WHERE EXISTS (SELECT 1 FROM responses WHERE id = ?)")
        .bind(id, user.name, id)
    );
  }
  await c.env.DB.batch(statements);
  return (await findResponse(c, user.id))!;
}

userRoutes.get("/", (c) => c.redirect(c.get("user") ? "/home" : "/login"));

userRoutes.get("/legal", (c) => c.html(legalPage(pageContext(c))));
userRoutes.get("/blocked", (c) => c.html(blockedPage(pageContext(c))));

userRoutes.post("/lang", async (c) => {
  const body = await c.req.parseBody();
  const lang: Lang = body.lang === "it" ? "it" : "en";
  setCookie(c, "cs_lang", lang, { path: "/", secure: true, sameSite: "Lax", maxAge: 31536000 });
  const user = c.get("user");
  if (user) await c.env.DB.prepare("UPDATE users SET lang = ? WHERE id = ?").bind(lang, user.id).run();
  return c.redirect(safeNext(body.next, "/"), 303);
});

userRoutes.get("/home", requireLogin, async (c) => {
  const user = c.get("user")!;
  if (user.status === "blocked") return c.redirect(user.role === "admin" ? "/admin" : "/blocked");
  const response = await findResponse(c, user.id);
  return c.html(homePage(pageContext(c), response?.status ?? "none"));
});

userRoutes.get("/consent", requireLogin, async (c) => {
  const user = c.get("user")!;
  if (user.status === "blocked") return c.redirect("/blocked");
  if ((await consentState(c.env.DB, user.id)) === "confirmed") return c.redirect("/survey");
  return c.html(consentPage(pageContext(c)));
});

userRoutes.post("/consent", requireLogin, async (c) => {
  const user = c.get("user")!;
  if (user.status === "blocked") return c.redirect("/blocked", 303);
  const body = await c.req.parseBody();
  if (body.confirm !== "1") return c.html(consentPage(pageContext(c), true), 400);
  await recordConsent(c.env.DB, user.id, "confirm", c.get("lang"), "platform").run();
  return c.redirect("/survey", 303);
});

userRoutes.get("/survey", requireParticipant, async (c) => {
  const response = await ensureResponse(c);
  if (response.status === "completed") return c.redirect("/result");
  const rows = await loadAnswers(c.env.DB, response.id);
  const requested = Number(c.req.query("s"));
  // Senza sezione indicata si riprende dalla prima incompleta.
  const firstOpen = SECTIONS.findIndex((s) => missingQuestions(s.questions, rows).length > 0);
  const index = Number.isInteger(requested) && SECTIONS[requested] ? requested : Math.max(firstOpen, 0);
  return c.html(surveyPage(pageContext(c), index, SECTIONS[index]!, rowsToValues(rows), []));
});

/** Salvataggio automatico: accetta risposte parziali, ma mai codici non validi. */
userRoutes.post("/survey/save", requireParticipant, async (c) => {
  const response = await ensureResponse(c);
  if (response.status !== "in_progress") return c.json({ ok: false }, 409);
  const values = formToValues(await c.req.formData());
  const section = SECTIONS[Number(values.section?.[0])];
  if (!section) return c.json({ ok: false }, 400);
  try {
    const rows = parseQuestions(section.questions, values);
    await c.env.DB.batch(saveSectionStatements(c.env.DB, response.id, section, rows));
    return c.json({ ok: true });
  } catch (error) {
    if (error instanceof InvalidSubmission) return c.json({ ok: false, error: error.message }, 400);
    throw error;
  }
});

function completionStatements(c: Context<AppEnv>, responseId: string, rows: AnswerRow[]) {
  return [
    ...clusterStatements(c.env.DB, responseId, rows),
    c.env.DB
      .prepare("UPDATE responses SET status = 'completed', completed_at = ?, language = ? WHERE id = ? AND status = 'in_progress'")
      .bind(nowIso(), c.get("lang"), responseId)
  ];
}

userRoutes.post("/survey/section", requireParticipant, async (c) => {
  const response = await ensureResponse(c);
  if (response.status !== "in_progress") return c.redirect("/result", 303);
  const values = formToValues(await c.req.formData());
  const index = Number(values.section?.[0]);
  const section = SECTIONS[index];
  if (!section) return c.redirect("/survey", 303);

  let rows: AnswerRow[];
  try {
    rows = parseQuestions(section.questions, values);
  } catch (error) {
    if (error instanceof InvalidSubmission) return c.text(error.message, 400);
    throw error;
  }
  await c.env.DB.batch(saveSectionStatements(c.env.DB, response.id, section, rows));

  const missing = missingQuestions(section.questions, rows);
  if (missing.length > 0) return c.html(surveyPage(pageContext(c), index, section, values, missing), 400);
  if (index < SECTIONS.length - 1) return c.redirect(`/survey?s=${index + 1}`, 303);

  const all = await loadAnswers(c.env.DB, response.id);
  const firstOpen = SECTIONS.findIndex((s) => missingQuestions(s.questions, all).length > 0);
  if (firstOpen >= 0) return c.redirect(`/survey?s=${firstOpen}`, 303);

  await c.env.DB.batch(completionStatements(c, response.id, all));
  return c.redirect("/result", 303);
});

userRoutes.get("/result", requireParticipant, async (c) => {
  const response = await findResponse(c, c.get("user")!.id);
  if (response?.status !== "completed") return c.redirect("/home");
  return c.html(resultPage(pageContext(c), await loadCluster(c.env.DB, response.id)));
});

userRoutes.get("/profile", requireLogin, async (c) => {
  const user = c.get("user")!;
  if (user.status === "blocked") return c.redirect(user.role === "admin" ? "/admin" : "/blocked");
  const response = await findResponse(c, user.id);
  const cluster = response?.status === "completed" ? await loadCluster(c.env.DB, response.id) : null;
  return c.html(
    profilePage(pageContext(c), {
      state: await consentState(c.env.DB, user.id),
      last: await lastConsentEvent(c.env.DB, user.id),
      cluster: cluster?.cluster ?? null
    })
  );
});

userRoutes.post("/profile/revoke", requireLogin, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  if (body.confirm !== "1") {
    return c.html(
      profilePage(pageContext(c), {
        state: await consentState(c.env.DB, user.id),
        last: await lastConsentEvent(c.env.DB, user.id),
        cluster: null,
        error: true
      }),
      400
    );
  }
  await c.env.DB.batch([
    recordConsent(c.env.DB, user.id, "revoke", c.get("lang"), "platform"),
    c.env.DB.prepare("UPDATE users SET status = 'blocked' WHERE id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id)
  ]);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.redirect("/blocked", 303);
});

