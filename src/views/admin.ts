// Questo è l'unico modulo che importa le definizioni riservate dei cluster.
import { html } from "hono/html";
import adminClusters from "../../content/clusters.admin.json";
import { PARAMS } from "../cluster/classifier";
import { LEGAL } from "../privacy/consent";
import type { Filters } from "../routes/admin";
import { answerIndex, DISPLAY_NUMBER, QUESTIONS, SURVEY } from "../survey/definition";
import { page, type Fragment, type PageContext } from "./layout";

export interface ReportData {
  registered: number;
  started: number;
  completed: number;
  clusters: Record<string, number>;
  confidence: Record<string, number>;
  answers: { question_id: string; item_code: string; option_code: number; n: number }[];
  openFlags: number;
  pendingClusters: number;
}

const pct = (value: number, total: number) => (total ? (value / total) * 100 : 0);
const pctLabel = (value: number) => `${value.toFixed(value > 0 && value < 10 ? 1 : 0)}%`;

function adminNav(active: string): Fragment {
  const items = [["/admin", "Report"], ["/admin/review", "Revisione"], ["/admin/users", "Utenti"], ["/admin/clusters", "Definizioni cluster"]] as const;
  return html`<nav class="tabs">${items.map(([href, label]) => html`<a href="${href}" class="${active === href ? "is-active" : ""}">${label}</a>`)}</nav>`;
}

/** Barra singola: stessa inchiostro per tutte, valore sempre scritto a fianco. */
function bar(value: number, label: string, marker?: number): Fragment {
  return html`<svg viewBox="0 0 100 10" preserveAspectRatio="none" class="chart-bar" role="img" aria-label="${label}">
    <title>${label}</title>
    <rect width="100" height="10" class="chart-track"/>
    <rect width="${Math.min(value, 100).toFixed(2)}" height="10" class="chart-fill"/>
    ${marker === undefined ? "" : html`<rect x="${Math.min(marker, 99.4).toFixed(2)}" width="0.6" height="10" class="chart-marker"/>`}
  </svg>`;
}

function kpi(label: string, value: string): Fragment {
  return html`<div class="kpi"><span class="kpi-value">${value}</span><span class="kpi-label">${label}</span></div>`;
}

function clusterSection(data: ReportData): Fragment {
  const total = Object.values(data.clusters).reduce((a, b) => a + b, 0);
  const conf = ["Netta", "Probabile", "Incerta"];
  return html`<section class="panel">
    <h2 class="title-m">Distribuzione dei cluster</h2>
    <p class="muted">Su ${total} rispondenti classificati. La tacca sulla barra indica la quota di mercato di riferimento.</p>
    <table class="chart-table">
      <thead><tr><th>Cluster</th><th class="wide">Quota</th><th class="num">Risposte</th><th class="num">%</th><th class="num">Mercato</th></tr></thead>
      <tbody>${PARAMS.cluster.map((c) => {
        const n = data.clusters[c.codice] ?? 0;
        const share = pct(n, total);
        const market = c.quota_mercato * 100;
        return html`<tr><td>${c.nome}</td>
          <td class="wide">${bar(share, `${c.nome}: ${pctLabel(share)}, mercato ${pctLabel(market)}`, market)}</td>
          <td class="num">${n}</td><td class="num">${pctLabel(share)}</td><td class="num">${pctLabel(market)}</td></tr>`;
      })}</tbody>
    </table>
    <h3 class="title-xs">Confidenza dell'assegnazione</h3>
    <div class="kpis kpis-small">${conf.map((k) => kpi(k, String(data.confidence[k] ?? 0)))}</div>
  </section>`;
}

function questionSection(data: ReportData): Fragment[] {
  const key = (q: string, item: string, code: number) => `${q}|${item}|${code}`;
  const counts = new Map(data.answers.map((a) => [key(a.question_id, a.item_code, a.option_code), a.n]));
  return QUESTIONS.filter((q) => q.type !== "text").map((q) => {
    const title = html`<h3 class="title-xs"><span class="q-number">${DISPLAY_NUMBER.get(q.id)}</span>${q.text.en} <span class="muted">(${q.id})</span></h3>`;
    if (q.type === "grid") {
      return html`<section class="panel">${title}
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>Item</th>${q.scale.map((s) => html`<th class="num">${s.en}</th>`)}</tr></thead>
          <tbody>${q.items.map((item) => html`<tr><td>${item.code === "TRAP" ? "TRAP" : `${item.code}. ${item.en}`}</td>
            ${q.scale.map((s) => {
              const n = counts.get(key(q.id, item.code, s.code)) ?? 0;
              return html`<td class="num" title="${answerIndex(q.id, s.code, item.code)}">${n}</td>`;
            })}</tr>`)}</tbody>
        </table></div></section>`;
    }
    return html`<section class="panel">${title}
      <table class="chart-table">
        <thead><tr><th>Indice</th><th>Risposta</th><th class="wide">Quota</th><th class="num">N</th><th class="num">%</th></tr></thead>
        <tbody>${q.options.map((o) => {
          const n = counts.get(key(q.id, "", o.code)) ?? 0;
          const share = pct(n, data.completed);
          return html`<tr><td class="mono">${answerIndex(q.id, o.code)}</td><td>${o.en}</td>
            <td class="wide">${bar(share, `${o.en}: ${pctLabel(share)}`)}</td>
            <td class="num">${n}</td><td class="num">${pctLabel(share)}</td></tr>`;
        })}</tbody>
      </table></section>`;
  });
}

export function reportPage(ctx: PageContext, data: ReportData, f: Filters, recalc?: string) {
  const q4 = QUESTIONS.find((q) => q.id === "Q4");
  const areas = q4?.type === "single" ? q4.options : [];
  const query = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const [done, remaining] = (recalc ?? "").split("-");
  return page(ctx, "Report", html`
    <h1 class="title-l">${SURVEY.title.en}</h1>
    ${adminNav("/admin")}
    ${LEGAL.isPlaceholder ? html`<p class="notice">L'informativa privacy è ancora un placeholder: va sostituita prima del go-live.</p>` : ""}
    ${recalc ? html`<p class="notice">Classificate ${done} risposte. Ancora da classificare: ${remaining}.</p>` : ""}
    ${data.pendingClusters > 0 ? html`<form method="post" action="/admin/recalculate" class="notice notice-action">
        <span>${data.pendingClusters} risposte complete non hanno ancora un cluster.</span>
        <button class="btn btn-outline btn-inline">Calcola i cluster</button></form>` : ""}
    <form method="get" action="/admin" class="filters">
      <label>Origine<select name="origin">
        ${[["", "Tutte"], ["pilot", "Pilota"], ["internal", "Interni"], ["external", "Esterni"]].map(([v, l]) => html`<option value="${v}" ${f.origin === v ? "selected" : ""}>${l}</option>`)}
      </select></label>
      <label>Dal<input type="date" name="from" value="${f.from}"></label>
      <label>Al<input type="date" name="to" value="${f.to}"></label>
      <label>Area<select name="area"><option value="">Tutte</option>
        ${areas.map((a) => html`<option value="${a.code}" ${f.area === String(a.code) ? "selected" : ""}>${a.en.split(" – ")[0]}</option>`)}
      </select></label>
      <button class="btn btn-outline btn-inline">Applica</button>
      <a class="btn btn-outline btn-inline" href="/admin/export.csv${query ? `?${query}` : ""}">Esporta CSV</a>
    </form>
    <div class="kpis">
      ${kpi("Iscritti attivi", String(data.registered))}
      ${kpi("Avviati", String(data.started))}
      ${kpi("Completati", String(data.completed))}
      ${kpi("Tasso di completamento", pctLabel(pct(data.completed, data.started)))}
      ${kpi("Segnalazioni aperte", String(data.openFlags))}
    </div>
    ${clusterSection(data)}
    <h2 class="title-m">Risposte per domanda</h2>
    ${questionSection(data)}`);
}

const FLAG_LABELS: Record<string, string> = {
  trap_fallita: "Domanda trappola sbagliata",
  non_si_trucca: "Non si trucca mai",
  non_classificabile: "Non classificabile"
};

export function reviewPage(
  ctx: PageContext,
  rows: { id: number; flag: string; status: string; reviewed_by: string | null; rid: string; source: string; cluster_name: string | null; error: string | null }[]
) {
  return page(ctx, "Revisione", html`
    <h1 class="title-l">Revisione</h1>
    ${adminNav("/admin/review")}
    <p class="muted">Le segnalazioni non escludono nessuno: decidi tu se tenere o escludere il caso da report ed export. L'utente continua a vedere il suo cluster.</p>
    ${rows.length === 0 ? html`<p class="panel">Nessuna segnalazione.</p>` : html`
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>RID</th><th>Origine</th><th>Segnalazione</th><th>Cluster</th><th>Stato</th><th>Azione</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr>
        <td class="mono">${r.rid}</td>
        <td>${r.source === "forms_pilot" ? "Pilota" : "Piattaforma"}</td>
        <td>${FLAG_LABELS[r.flag] ?? r.flag}</td>
        <td>${r.cluster_name ?? r.error ?? "-"}</td>
        <td>${{ open: "Aperta", kept: "Tenuto", excluded: "Escluso" }[r.status] ?? r.status}</td>
        <td><form method="post" action="/admin/review/${r.id}" class="row-actions">
          ${r.status === "open"
            ? html`<button name="action" value="keep" class="btn btn-outline btn-tiny">Tieni</button><button name="action" value="exclude" class="btn btn-outline btn-tiny">Escludi</button>`
            : html`<button name="action" value="reopen" class="btn btn-outline btn-tiny">Riapri</button>`}
        </form></td>
      </tr>`)}</tbody>
    </table></div>`}`);
}

export function usersPage(
  ctx: PageContext,
  rows: { id: string; email: string; name: string | null; user_type: string; status: string; last_login_at: string | null; consent: string | null }[]
) {
  const consent: Record<string, string> = {
    confirm: "Confermata",
    revoke: "Revocata",
    unblock: "Da riconfermare",
    not_recorded: "Non registrata"
  };
  return page(ctx, "Utenti", html`
    <h1 class="title-l">Utenti</h1>
    ${adminNav("/admin/users")}
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>Email</th><th>Nome</th><th>Tipo</th><th>Privacy</th><th>Stato</th><th>Ultimo accesso</th><th></th></tr></thead>
      <tbody>${rows.map((u) => html`<tr>
        <td>${u.email}</td><td>${u.name ?? "-"}</td>
        <td>${u.user_type === "internal" ? "Interno" : "Esterno"}</td>
        <td>${consent[u.consent ?? ""] ?? "Da confermare"}</td>
        <td>${u.status === "blocked" ? "Bloccato" : "Attivo"}</td>
        <td>${u.last_login_at?.slice(0, 10) ?? "-"}</td>
        <td>${u.status === "blocked" ? html`<form method="post" action="/admin/users/${u.id}/unblock"><button class="btn btn-outline btn-tiny">Sblocca</button></form>` : ""}</td>
      </tr>`)}</tbody>
    </table></div>`);
}

type AdminCluster = {
  approach: string[];
  drivers: string[];
  features: string[];
  demographics: string;
  market: { consumers: string; expense: string; annual: string };
};

export function clustersPage(ctx: PageContext) {
  const all = adminClusters as unknown as Record<string, AdminCluster>;
  const list = (title: string, items: string[]) =>
    items.length ? html`<h3 class="title-xs">${title}</h3><ul class="list">${items.map((i) => html`<li>${i}</li>`)}</ul>` : "";
  return page(ctx, "Definizioni cluster", html`
    <h1 class="title-l">Definizioni cluster</h1>
    ${adminNav("/admin/clusters")}
    <p class="notice">Testi placeholder da "Descrizione clusters.docx". Visibili solo agli admin.</p>
    ${PARAMS.cluster.map((c) => {
      const d = all[c.codice]!;
      return html`<section class="panel">
        <h2 class="title-m">${c.nome} <span class="muted">(${c.codice})</span></h2>
        ${list("Approach to beauty", d.approach)}
        ${list("Purchase drivers", d.drivers)}
        ${list("Outlining product features", d.features)}
        <h3 class="title-xs">Demographics</h3><p>${d.demographics}</p>
        <h3 class="title-xs">Market relevance</h3>
        <p>Consumers: ${d.market.consumers} · Expense: ${d.market.expense} · Average annual expense: ${d.market.annual}</p>
      </section>`;
    })}`);
}
