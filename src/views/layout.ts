import { html } from "hono/html";
import type { Lang, SessionUser, Theme } from "../env";
import { t } from "../i18n";

export interface PageContext { lang: Lang; theme: Theme; user: SessionUser | null; path: string }
export type Fragment = ReturnType<typeof html>;

const flagIt = html`<svg viewBox="0 0 30 20" width="30" height="20" aria-hidden="true"><rect width="10" height="20" fill="#009246"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#ce2b37"/></svg>`;
const flagEn = html`<svg viewBox="0 0 60 40" width="30" height="20" aria-hidden="true"><rect width="60" height="40" fill="#012169"/><path d="M0 0l60 40M60 0L0 40" stroke="#fff" stroke-width="8"/><path d="M0 0l60 40M60 0L0 40" stroke="#c8102e" stroke-width="3"/><path d="M30 0v40M0 20h60" stroke="#fff" stroke-width="12"/><path d="M30 0v40M0 20h60" stroke="#c8102e" stroke-width="7"/></svg>`;
const iconTheme = html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2.2h5.2c0-1 .4-1.7 1-2.2A6 6 0 0 0 12 3z"/></svg>`;

export function preferences(ctx: PageContext): Fragment {
  const langButton = (code: Lang, label: string, flag: Fragment) => html`
    <button class="pref ${ctx.lang === code ? "is-active" : ""}" name="lang" value="${code}" aria-label="${label}" aria-pressed="${ctx.lang === code}">${flag}</button>`;
  return html`
    <div class="prefs">
      <button type="button" class="pref" data-theme-toggle aria-label="${t(ctx.lang, "theme")}">${iconTheme}</button>
      <span class="prefs-sep" aria-hidden="true"></span>
      <form method="post" action="/lang" class="prefs-lang" data-lang-form>
        <input type="hidden" name="next" value="${ctx.path}">
        ${langButton("it", "Italiano", flagIt)}
        ${langButton("en", "English", flagEn)}
      </form>
    </div>`;
}

export function shell(ctx: PageContext, title: string, body: Fragment | Promise<string> | string, extraHead: Fragment | string = ""): Fragment {
  return html`<!doctype html>
<html lang="${ctx.lang}" data-theme="${ctx.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ChromaSurvey</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
${extraHead}
</head>
<body>${body}</body>
</html>`;
}

export function page(ctx: PageContext, title: string, body: Fragment, extraHead: Fragment | string = ""): Fragment {
  const u = ctx.user;
  const nav = html`
    <header class="topbar">
      <a href="/home" class="topbar-brand"><img src="/logo-white.png" alt="Chromavis" class="logo logo-small"><span>ChromaSurvey</span></a>
      <nav class="topbar-nav">
        ${u ? html`<a href="/home">${t(ctx.lang, "home")}</a><a href="/profile">${t(ctx.lang, "profile")}</a>` : ""}
        ${u?.role === "admin" ? html`<a href="/admin">${t(ctx.lang, "admin")}</a>` : ""}
        ${u ? html`<form method="post" action="/auth/logout"><button class="link-button">${t(ctx.lang, "signOut")}</button></form>` : ""}
      </nav>
      ${preferences(ctx)}
    </header>`;
  return shell(ctx, title, html`${nav}<main class="container">${body}</main>`, extraHead);
}

export function card(ctx: PageContext, title: string, body: Fragment, extraHead: Fragment | string = ""): Fragment {
  return shell(ctx, title, html`
    <main class="auth">
      <div class="auth-brand">
        <img src="/logo-white.png" alt="Chromavis" class="logo">
        <p class="wordmark">ChromaSurvey</p>
      </div>
      ${body}
      ${preferences(ctx)}
    </main>`, extraHead);
}
