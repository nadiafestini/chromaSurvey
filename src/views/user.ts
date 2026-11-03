import { html } from "hono/html";
import clusters from "../../content/clusters.json";
import { PARAMS } from "../cluster/classifier";
import type { ClusterRow } from "../cluster/store";
import { t } from "../i18n";
import { LEGAL, type ConsentEvent, type ConsentState } from "../privacy/consent";
import { DISPLAY_NUMBER, QUESTIONS, SURVEY, type Question, type Section } from "../survey/definition";
import type { FormValues } from "../survey/answers";
import { page, type Fragment, type PageContext } from "./layout";

type ResponseStatus = "none" | "in_progress" | "completed";
type ClusterText = { tagline: Record<string, string>; approach: Record<string, string[]>; drivers: Record<string, string[]> };
const TEXTS = clusters.clusters as unknown as Record<string, ClusterText>;

const clusterName = (code: string | null) => PARAMS.cluster.find((c) => c.codice === code)?.nome ?? "";

export function homePage(ctx: PageContext, status: ResponseStatus) {
  const l = ctx.lang;
  const label = { none: t(l, "statusNew"), in_progress: t(l, "statusProgress"), completed: t(l, "statusDone") }[status];
  const action =
    status === "completed"
      ? html`<a class="btn btn-solid btn-inline" href="/result">${t(l, "seeResult")}</a>`
      : html`<a class="btn btn-solid btn-inline" href="/survey">${t(l, status === "none" ? "start" : "resume")}</a>`;
  return page(ctx, t(l, "home"), html`
    <h1 class="title-l">${t(l, "welcome")}${ctx.user?.name ? html`, ${ctx.user.name}` : ""}</h1>
    <p class="lead">${t(l, status === "completed" ? "statusDone" : "homeLead")}</p>
    <section class="panel survey-card">
      <div>
        <span class="badge">${label}</span>
        <h2 class="title-m">${t(l, "surveyTitle")}</h2>
        <p class="muted">${t(l, "surveyDesc")}</p>
      </div>
      ${action}
    </section>`);
}

export function consentPage(ctx: PageContext, error = false) {
  const l = ctx.lang;
  return page(ctx, t(l, "consentTitle"), html`
    <h1 class="title-l">${t(l, "consentTitle")}</h1>
    ${l === "it" ? html`<p class="muted">${t(l, "consentEnglishOnly")}</p>` : ""}
    <section class="panel prose" lang="en">
      <h2 class="title-m">${LEGAL.noticeTitle}</h2>
      ${LEGAL.notice.map((p) => html`<p>${p}</p>`)}
    </section>
    ${error ? html`<p class="alert" role="alert">${t(l, "consentRequired")}</p>` : ""}
    <form method="post" action="/consent" class="stack">
      <label class="check check-consent" lang="en">
        <input type="checkbox" name="confirm" value="1" required>
        <span>${LEGAL.consent}</span>
      </label>
      <button class="btn btn-solid btn-inline">${t(l, "consentContinue")}</button>
    </form>`);
}

function questionField(q: Question, ctx: PageContext, values: FormValues, showError: boolean): Fragment {
  const l = ctx.lang;
  const own = values[q.id] ?? [];
  const has = (code: number) => own.includes(String(code));
  const number = DISPLAY_NUMBER.get(q.id);
  const error = showError ? html`<p class="alert alert-inline" role="alert">${t(l, "required")}</p>` : "";

  if (q.type === "text") {
    return html`<fieldset class="question" id="${q.id}"><legend><span class="q-number">${number}</span>${q.text[l]}</legend>
      ${error}<input name="${q.id}" maxlength="200" required placeholder="${t(l, "textPlaceholder")}" value="${own[0] ?? ""}" aria-label="${q.text[l]}"></fieldset>`;
  }
  if (q.type === "single") {
    return html`<fieldset class="question" id="${q.id}"><legend><span class="q-number">${number}</span>${q.text[l]}</legend>
      <p class="hint">${t(l, "pickOne")}</p>${error}
      <div class="options">${q.options.map((o) => html`
        <label class="check"><input type="radio" name="${q.id}" value="${o.code}" ${has(o.code) ? "checked" : ""}><span>${o[l]}</span></label>`)}</div></fieldset>`;
  }
  if (q.type === "multi") {
    const hint = q.max ? t(l, "maxAnswers").replace("{max}", String(q.max)) : t(l, "pickAny");
    return html`<fieldset class="question" id="${q.id}" data-multi data-max="${q.max ?? ""}" data-none="${q.noneCode}"><legend><span class="q-number">${number}</span>${q.text[l]}</legend>
      <p class="hint">${hint}</p>${error}
      <div class="options">${q.options.map((o) => html`
        <label class="check"><input type="checkbox" name="${q.id}" value="${o.code}" ${has(o.code) ? "checked" : ""}><span>${o[l]}</span></label>`)}</div></fieldset>`;
  }
  return html`<fieldset class="question" id="${q.id}"><legend><span class="q-number">${number}</span>${q.text[l]}</legend>
    ${error}
    <div class="grid-scale" aria-hidden="true"><span></span>${q.scale.map((s) => html`<span>${s[l]}</span>`)}</div>
    ${q.items.map((item) => {
      const name = `${q.id}.${item.code}`;
      const chosen = values[name]?.[0];
      return html`<div class="grid-row" role="radiogroup" aria-label="${item[l]}">
        <p class="grid-label">${item[l]}</p>
        <div class="grid-options">${q.scale.map((s) => html`
          <label class="grid-cell"><input type="radio" name="${name}" value="${s.code}" ${chosen === String(s.code) ? "checked" : ""}><span>${s[l]}</span></label>`)}</div>
      </div>`;
    })}</fieldset>`;
}

export function surveyPage(ctx: PageContext, index: number, section: Section, values: FormValues, missing: string[]) {
  const l = ctx.lang;
  const total = SURVEY.sections.length;
  const isLast = index === total - 1;
  const done = SURVEY.sections.slice(0, index).reduce((n, s) => n + s.questions.length, 0);
  // Il cambio lingua deve restare su questa sezione, anche se è già completa.
  return page({ ...ctx, path: `/survey?s=${index}` }, section.title[l], html`
    <div class="progress" aria-label="${t(l, "section")} ${index + 1} ${t(l, "of")} ${total}">
      <span class="progress-text">${t(l, "section")} ${index + 1} ${t(l, "of")} ${total}</span>
      <svg viewBox="0 0 100 2" preserveAspectRatio="none" class="progress-bar" aria-hidden="true"><rect width="100" height="2" class="track"/><rect width="${(done / QUESTIONS.length) * 100}" height="2" class="fill"/></svg>
    </div>
    <h1 class="title-l">${section.title[l]}</h1>
    <form method="post" action="/survey/section" class="stack-l" data-survey data-section="${index}">
      <input type="hidden" name="section" value="${index}">
      ${section.questions.map((q) => questionField(q, ctx, values, missing.includes(q.id)))}
      <div class="survey-actions">
        ${index > 0 ? html`<a class="btn btn-outline btn-inline" href="/survey?s=${index - 1}">${t(l, "back")}</a>` : html`<span></span>`}
        <span class="save-state" data-save-state aria-live="polite" data-saved="${t(l, "saved")}"></span>
        <button class="btn btn-solid btn-inline">${t(l, isLast ? "finish" : "next")}</button>
      </div>
    </form>`);
}

/** Radar in SVG: la forma usa la radice dell'affinità, per restare leggibile anche con valori piccoli. */
function radar(row: ClusterRow, affinities: Record<string, number>): Fragment {
  const cx = 190;
  const cy = 160;
  const R = 110;
  const points = PARAMS.cluster.map((c, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / PARAMS.cluster.length;
    const value = Math.sqrt(affinities[c.codice] ?? 0);
    const cos = Math.cos(angle);
    return {
      code: c.codice,
      // Etichetta breve sul bordo: la prima parola significativa del nome.
      label: c.nome.replace(/^The /, "").split(/[ -]/)[0]!,
      anchor: Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end",
      x: cx + cos * R * value,
      y: cy + Math.sin(angle) * R * value,
      ax: cx + cos * R,
      ay: cy + Math.sin(angle) * R,
      lx: cx + cos * (R + 10),
      ly: cy + Math.sin(angle) * (R + 12) + 4
    };
  });
  const polygon = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return html`<svg viewBox="0 0 380 320" class="radar" aria-hidden="true">
    ${[1, 0.66, 0.33].map((k) => html`<circle cx="${cx}" cy="${cy}" r="${R * k}" class="radar-ring"/>`)}
    ${points.map((p) => html`<line x1="${cx}" y1="${cy}" x2="${p.ax.toFixed(1)}" y2="${p.ay.toFixed(1)}" class="radar-axis"/>`)}
    <polygon points="${polygon}" class="radar-shape"/>
    ${points.map((p) => html`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.code === row.cluster ? 6 : 3}" class="radar-dot ${p.code === row.cluster ? "is-main" : ""}"/>`)}
    ${points.map((p) => html`<text x="${p.lx.toFixed(1)}" y="${p.ly.toFixed(1)}" text-anchor="${p.anchor}" class="radar-label ${p.code === row.cluster ? "is-main" : ""}">${p.label}</text>`)}
  </svg>`;
}

function affinityBars(row: ClusterRow, affinities: Record<string, number>): Fragment {
  const sorted = [...PARAMS.cluster].sort((a, b) => (affinities[b.codice] ?? 0) - (affinities[a.codice] ?? 0));
  const max = Math.max(...Object.values(affinities), 0.0001);
  return html`<ul class="affinity">
    ${sorted.map((c) => {
      const value = affinities[c.codice] ?? 0;
      const pct = (value * 100).toFixed(value < 0.1 ? 1 : 0);
      const cls = c.codice === row.cluster ? "is-main" : c.codice === row.cluster_2 ? "is-second" : "";
      return html`<li class="affinity-row ${cls}">
        <span class="affinity-name">${c.nome}</span>
        <svg viewBox="0 0 100 8" preserveAspectRatio="none" class="affinity-bar" role="img" aria-label="${c.nome}: ${pct}%">
          <title>${c.nome}: ${pct}%</title>
          <rect width="${Math.max((value / max) * 100, 0.5).toFixed(2)}" height="8" class="affinity-fill"/>
        </svg>
        <span class="affinity-value">${pct}%</span>
      </li>`;
    })}
  </ul>`;
}

export function resultPage(ctx: PageContext, row: ClusterRow | null) {
  const l = ctx.lang;
  if (!row?.cluster) {
    return page(ctx, t(l, "resultKicker"), html`
      <h1 class="title-l">${t(l, "resultKicker")}</h1>
      <p class="panel">${t(l, "resultError")}</p>
      <a class="btn btn-outline btn-inline" href="/home">${t(l, "backHome")}</a>`);
  }
  const text = TEXTS[row.cluster];
  const affinities = JSON.parse(row.affinities_json ?? "{}") as Record<string, number>;
  const second = clusterName(row.cluster_2);
  const uncertain = row.confidence === "Incerta";
  return page(ctx, clusterName(row.cluster), html`
    <section class="reveal">
      <div class="reveal-copy">
        <p class="kicker">${t(l, "resultKicker")}</p>
        <h1 class="reveal-name">${clusterName(row.cluster).split(" ").map((w) => html`<span class="reveal-word">${w} </span>`)}</h1>
        <p class="reveal-tagline">${text?.tagline[l] ?? ""}</p>
        <p class="muted">${t(l, uncertain ? "resultUncertain" : "resultSecond")} <strong>${second}</strong>.</p>
      </div>
      ${radar(row, affinities)}
    </section>
    ${clusters.isPlaceholder ? html`<p class="fineprint-left">${t(l, "resultPlaceholder")}</p>` : ""}
    <div class="two-columns">
      <section class="panel">
        <h2 class="title-m">${t(l, "resultApproach")}</h2>
        <ul class="list">${(text?.approach[l] ?? []).map((s) => html`<li>${s}</li>`)}</ul>
      </section>
      <section class="panel">
        <h2 class="title-m">${t(l, "resultDrivers")}</h2>
        <ul class="list">${(text?.drivers[l] ?? []).map((s) => html`<li>${s}</li>`)}</ul>
      </section>
    </div>
    <section class="panel">
      <h2 class="title-m">${t(l, "resultAffinity")}</h2>
      ${affinityBars(row, affinities)}
    </section>
    <a class="btn btn-outline btn-inline" href="/home">${t(l, "backHome")}</a>`);
}

export function profilePage(
  ctx: PageContext,
  data: { state: ConsentState; last: ConsentEvent | null; cluster: string | null; error?: boolean }
) {
  const l = ctx.lang;
  const u = ctx.user!;
  const consent =
    data.state === "confirmed" && data.last
      ? `${t(l, "privacyConfirmed")} ${data.last.occurred_at.slice(0, 10)}`
      : t(l, "privacyNeeded");
  return page(ctx, t(l, "profileTitle"), html`
    <h1 class="title-l">${t(l, "profileTitle")}</h1>
    <section class="panel">
      <dl class="facts">
        <dt>${t(l, "nameLabel")}</dt><dd>${u.name ?? "-"}</dd>
        <dt>${t(l, "emailLabel")}</dt><dd>${u.email}</dd>
        <dt>${t(l, "privacyLabel")}</dt><dd>${consent} · <a href="/legal">${t(l, "readNotice")}</a></dd>
        ${data.cluster ? html`<dt>${t(l, "clusterLabel")}</dt><dd><a href="/result">${clusterName(data.cluster)}</a></dd>` : ""}
      </dl>
    </section>
    <section class="panel panel-danger">
      <h2 class="title-m">${t(l, "withdrawTitle")}</h2>
      <p class="muted">${t(l, "withdrawText")}</p>
      ${data.error ? html`<p class="alert" role="alert">${t(l, "consentRequired")}</p>` : ""}
      <form method="post" action="/profile/revoke" class="stack">
        <label class="check"><input type="checkbox" name="confirm" value="1" required><span>${t(l, "withdrawConfirm")}</span></label>
        <button class="btn btn-outline btn-inline">${t(l, "withdrawButton")}</button>
      </form>
    </section>`);
}
