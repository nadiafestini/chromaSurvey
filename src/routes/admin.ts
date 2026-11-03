import { Hono, type Context, type Next } from "hono";
import { CLASSIFIER_VERSION } from "../cluster/classifier";
import { recalculateMissing } from "../cluster/store";
import type { AppEnv } from "../env";
import { audit, nowIso } from "../lib";
import { recordConsent } from "../privacy/consent";
import { answerIndex, QUESTIONS, SURVEY } from "../survey/definition";
import { clustersPage, reportPage, reviewPage, usersPage, type ReportData } from "../views/admin";
import { pageContext } from "./context";

export const adminRoutes = new Hono<AppEnv>();

/** Il ruolo si controlla lato server su ogni rotta admin. */
adminRoutes.use("/admin/*", async (c: Context<AppEnv>, next: Next) => {
  const user = c.get("user");
  if (!user) return c.redirect("/login");
  if (user.role !== "admin") return c.text("Forbidden", 403);
  await next();
});
adminRoutes.use("/admin", async (c: Context<AppEnv>, next: Next) => {
  const user = c.get("user");
  if (!user) return c.redirect("/login");
  if (user.role !== "admin") return c.text("Forbidden", 403);
  await next();
});

export interface Filters { origin: string; from: string; to: string; area: string }

function readFilters(c: Context<AppEnv>): Filters {
  const date = (value: string | undefined) => (/^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? value! : "");
  const origin = c.req.query("origin") ?? "";
  const area = c.req.query("area") ?? "";
  return {
    origin: ["pilot", "internal", "external"].includes(origin) ? origin : "",
    from: date(c.req.query("from")),
    to: date(c.req.query("to")),
    area: /^\d{1,2}$/.test(area) ? area : ""
  };
}

/**
 * Perimetro di report ed export: esclude archiviate, escluse in revisione e utenti che hanno revocato.
 * Le condizioni usano solo testo fisso, i valori passano come parametri.
 */
function scope(f: Filters): { where: string; binds: unknown[] } {
  const conditions = ["r.survey_id = ?", "r.status <> 'archived'", "r.excluded_at IS NULL", "u.status = 'active'"];
  const binds: unknown[] = [SURVEY.id];
  if (f.origin === "pilot") conditions.push("r.source = 'forms_pilot'");
  if (f.origin === "internal") conditions.push("r.source = 'platform' AND u.user_type = 'internal'");
  if (f.origin === "external") conditions.push("r.source = 'platform' AND u.user_type = 'external'");
  if (f.from) { conditions.push("substr(COALESCE(r.completed_at, r.started_at), 1, 10) >= ?"); binds.push(f.from); }
  if (f.to) { conditions.push("substr(COALESCE(r.completed_at, r.started_at), 1, 10) <= ?"); binds.push(f.to); }
  if (f.area) {
    conditions.push("EXISTS (SELECT 1 FROM answers fa WHERE fa.response_id = r.id AND fa.question_id = 'Q4' AND fa.option_code = ?)");
    binds.push(Number(f.area));
  }
  return { where: conditions.join(" AND "), binds };
}

async function loadReport(db: D1Database, f: Filters): Promise<ReportData> {
  const { where, binds } = scope(f);
  const base = `FROM responses r JOIN users u ON u.id = r.user_id WHERE ${where}`;
  const completedIds = `SELECT r.id ${base} AND r.status = 'completed'`;

  const [registered, kpi, clusters, confidence, answers, flags, pending] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'active'"),
    db.prepare(`SELECT COUNT(*) AS started, SUM(r.status = 'completed') AS completed ${base}`).bind(...binds),
    db
      .prepare(`SELECT cluster, COUNT(*) AS n FROM cluster_results WHERE classifier_version = ? AND cluster IS NOT NULL AND response_id IN (${completedIds}) GROUP BY cluster`)
      .bind(CLASSIFIER_VERSION, ...binds),
    db
      .prepare(`SELECT confidence, COUNT(*) AS n FROM cluster_results WHERE classifier_version = ? AND cluster IS NOT NULL AND response_id IN (${completedIds}) GROUP BY confidence`)
      .bind(CLASSIFIER_VERSION, ...binds),
    db
      .prepare(`SELECT question_id, item_code, option_code, COUNT(*) AS n FROM answers WHERE question_id <> 'Q2' AND response_id IN (${completedIds}) GROUP BY question_id, item_code, option_code`)
      .bind(...binds),
    db.prepare("SELECT COUNT(*) AS n FROM review_flags WHERE status = 'open'"),
    db
      .prepare(`SELECT COUNT(*) AS n FROM responses r LEFT JOIN cluster_results c ON c.response_id = r.id AND c.classifier_version = ? WHERE r.status IN ('completed', 'archived') AND c.response_id IS NULL`)
      .bind(CLASSIFIER_VERSION)
  ]);

  const first = <T>(res: D1Result<unknown> | undefined) => res?.results[0] as T;
  const counts = first<{ started: number; completed: number | null }>(kpi);
  return {
    registered: first<{ n: number }>(registered).n,
    started: counts.started,
    completed: counts.completed ?? 0,
    clusters: Object.fromEntries((clusters?.results as { cluster: string; n: number }[]).map((r) => [r.cluster, r.n])),
    confidence: Object.fromEntries((confidence?.results as { confidence: string; n: number }[]).map((r) => [r.confidence, r.n])),
    answers: answers?.results as ReportData["answers"],
    openFlags: first<{ n: number }>(flags).n,
    pendingClusters: first<{ n: number }>(pending).n
  };
}

adminRoutes.get("/admin", async (c) => {
  const filters = readFilters(c);
  const data = await loadReport(c.env.DB, filters);
  const notice = c.req.query("recalc");
  return c.html(reportPage(pageContext(c), data, filters, notice));
});

adminRoutes.post("/admin/recalculate", async (c) => {
  const result = await recalculateMissing(c.env.DB);
  await audit(c.env.DB, c.get("user")!.email, "recalculate_clusters", result);
  return c.redirect(`/admin?recalc=${result.done}-${result.remaining}`, 303);
});

const csvCell = (value: unknown) => {
  let text = String(value ?? "");
  // Evita che Excel interpreti una cella come formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

adminRoutes.get("/admin/export.csv", async (c) => {
  const db = c.env.DB;
  const filters = readFilters(c);
  const { where, binds } = scope(filters);
  const [responses, answers] = await db.batch([
    db
      .prepare(
        `SELECT r.id, r.rid, r.source, u.user_type, r.language, r.completed_at, c.cluster, c.cluster_name, c.cluster_2,
                c.margin, c.confidence, c.weak_profile, c.rule, c.flags_json
         FROM responses r JOIN users u ON u.id = r.user_id
         LEFT JOIN cluster_results c ON c.response_id = r.id AND c.classifier_version = ?
         WHERE ${where} AND r.status = 'completed' ORDER BY r.rid`
      )
      .bind(CLASSIFIER_VERSION, ...binds),
    db
      .prepare(
        `SELECT a.response_id, a.question_id, a.item_code, a.option_code FROM answers a
         WHERE a.question_id <> 'Q2' AND a.response_id IN (SELECT r.id FROM responses r JOIN users u ON u.id = r.user_id WHERE ${where} AND r.status = 'completed')
         ORDER BY a.option_code`
      )
      .bind(...binds)
  ]);

  const byResponse = new Map<string, Map<string, number[]>>();
  for (const a of answers?.results as { response_id: string; question_id: string; item_code: string; option_code: number }[]) {
    const key = a.item_code ? `${a.question_id}_${a.item_code}` : a.question_id;
    const own = byResponse.get(a.response_id) ?? new Map<string, number[]>();
    own.set(key, [...(own.get(key) ?? []), a.option_code]);
    byResponse.set(a.response_id, own);
  }

  // Colonne per domanda: indice stabile (12.a;12.c) e codici (1;3). Nome ed email non vengono esportati.
  const columns = QUESTIONS.flatMap((q) => {
    if (q.type === "text") return [];
    if (q.type === "grid") return q.items.map((i) => ({ key: `${q.id}_${i.code}`, q: q.id, item: i.code }));
    return [{ key: q.id, q: q.id, item: "" }];
  });
  const header = [
    "rid", "origin", "language", "completed_at", "cluster", "cluster_name", "cluster_2", "margin", "confidence",
    "weak_profile", "rule", "flags", ...columns.flatMap((col) => [`${col.key}_index`, `${col.key}_code`])
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of responses?.results as Record<string, unknown>[]) {
    const own = byResponse.get(r.id as string);
    const origin = r.source === "forms_pilot" ? "pilot" : r.user_type;
    const flags = r.flags_json ? (JSON.parse(r.flags_json as string) as string[]).join(";") : "";
    lines.push(
      [
        r.rid, origin, r.language, r.completed_at, r.cluster, r.cluster_name, r.cluster_2, r.margin, r.confidence,
        r.weak_profile, r.rule, flags,
        ...columns.flatMap((col) => {
          const codes = own?.get(col.key) ?? [];
          return [codes.map((code) => answerIndex(col.q, code, col.item)).join(";"), codes.join(";")];
        })
      ].map(csvCell).join(",")
    );
  }
  await audit(db, c.get("user")!.email, "export_csv", { filters, rows: lines.length - 1 });
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="chromasurvey-${nowIso().slice(0, 10)}.csv"`
    }
  });
});

adminRoutes.get("/admin/review", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT f.id, f.flag, f.status, f.reviewed_by, f.reviewed_at, r.rid, r.source, c.cluster_name, c.error
       FROM review_flags f JOIN responses r ON r.id = f.response_id
       LEFT JOIN cluster_results c ON c.response_id = r.id AND c.classifier_version = ?
       WHERE r.status <> 'archived'
       ORDER BY f.status = 'open' DESC, r.rid`
    )
    .bind(CLASSIFIER_VERSION)
    .all<Parameters<typeof reviewPage>[1][number]>();
  return c.html(reviewPage(pageContext(c), results));
});

adminRoutes.post("/admin/review/:id", async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const action = (await c.req.parseBody()).action;
  const actor = c.get("user")!.email;
  const flag = await db.prepare("SELECT response_id FROM review_flags WHERE id = ?").bind(id).first<{ response_id: string }>();
  if (!flag) return c.notFound();
  const now = nowIso();
  const setFlag = (status: string) =>
    db.prepare("UPDATE review_flags SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?").bind(status, actor, now, id);

  if (action === "exclude") {
    await db.batch([setFlag("excluded"), db.prepare("UPDATE responses SET excluded_at = ?, excluded_by = ? WHERE id = ?").bind(now, actor, flag.response_id)]);
  } else if (action === "keep") {
    await setFlag("kept").run();
  } else if (action === "reopen") {
    await db.batch([
      db.prepare("UPDATE review_flags SET status = 'open', reviewed_by = NULL, reviewed_at = NULL WHERE id = ?").bind(id),
      db
        .prepare("UPDATE responses SET excluded_at = NULL, excluded_by = NULL WHERE id = ? AND NOT EXISTS (SELECT 1 FROM review_flags WHERE response_id = ? AND status = 'excluded')")
        .bind(flag.response_id, flag.response_id)
    ]);
  } else {
    return c.text("Azione non valida", 400);
  }
  await audit(db, actor, "review_flag", { id, action });
  return c.redirect("/admin/review", 303);
});

adminRoutes.get("/admin/users", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT u.id, u.email, u.name, u.user_type, u.status, u.last_login_at,
         (SELECT action FROM consent_events e WHERE e.user_id = u.id ORDER BY e.id DESC LIMIT 1) AS consent
       FROM users u ORDER BY u.status = 'blocked' DESC, u.email LIMIT 1000`
    )
    .all<Parameters<typeof usersPage>[1][number]>();
  return c.html(usersPage(pageContext(c), results));
});

adminRoutes.post("/admin/users/:id/unblock", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const changed = await db.prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'blocked'").bind(id).run();
  if (changed.meta.changes === 1) {
    // Dopo lo sblocco l'ultimo evento non è una conferma: l'utente deve confermare di nuovo.
    await recordConsent(db, id, "unblock", c.get("lang"), "admin").run();
    await audit(db, c.get("user")!.email, "unblock_user", { id });
  }
  return c.redirect("/admin/users", 303);
});

adminRoutes.get("/admin/clusters", (c) => c.html(clustersPage(pageContext(c))));

