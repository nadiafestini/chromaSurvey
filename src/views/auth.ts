import { html } from "hono/html";
import { t, type StringKey } from "../i18n";
import { LEGAL } from "../privacy/consent";
import { card, type PageContext } from "./layout";

const msLogo = html`<svg viewBox="0 0 21 21" width="21" height="21" aria-hidden="true"><rect width="10" height="10" fill="#f25022"/><rect x="11" width="10" height="10" fill="#7fba00"/><rect y="11" width="10" height="10" fill="#00a4ef"/><rect x="11" y="11" width="10" height="10" fill="#ffb900"/></svg>`;

export interface LoginForm { first?: string; last?: string; email?: string }

export function loginPage(ctx: PageContext, opts: { siteKey: string; error?: StringKey; form?: LoginForm }) {
  const l = ctx.lang;
  const f = opts.form ?? {};
  const widget = opts.siteKey && !opts.siteKey.startsWith("PLACEHOLDER");
  const head = widget ? html`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : "";
  const body = html`
    <a class="btn btn-solid" href="/auth/microsoft">${msLogo}<span>${t(l, "signInMicrosoft")}</span></a>
    <div class="divider"><span>${t(l, "or")}</span></div>
    <p class="muted">${t(l, "otpIntro")}</p>
    ${opts.error ? html`<p class="alert" role="alert">${t(l, opts.error)}</p>` : ""}
    <form method="post" action="/auth/otp/request" class="stack">
      <div class="row">
        <input name="first" required maxlength="80" autocomplete="given-name" placeholder="${t(l, "firstName")}" aria-label="${t(l, "firstName")}" value="${f.first ?? ""}">
        <input name="last" required maxlength="80" autocomplete="family-name" placeholder="${t(l, "lastName")}" aria-label="${t(l, "lastName")}" value="${f.last ?? ""}">
      </div>
      <input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="${t(l, "emailPlaceholder")}" aria-label="Email" value="${f.email ?? ""}">
      ${widget ? html`<div class="cf-turnstile" data-sitekey="${opts.siteKey}" data-theme="${ctx.theme}"></div>` : ""}
      <button class="btn btn-outline">${t(l, "getCode")}</button>
    </form>
    <p class="fineprint">${t(l, "legalLine")}</p>
    <p class="fineprint fineprint-dim">${t(l, "cookieLine")} <a href="/legal">${t(l, "legalLink")}</a></p>`;
  return card(ctx, "Login", body, head);
}

export function otpVerifyPage(ctx: PageContext, email: string, error?: StringKey) {
  const l = ctx.lang;
  return card(ctx, t(l, "checkEmail"), html`
    <h1 class="title-s">${t(l, "checkEmail")}</h1>
    <p class="muted">${t(l, "codeSent")}</p>
    ${error ? html`<p class="alert" role="alert">${t(l, error)}</p>` : ""}
    <form method="post" action="/auth/otp/verify" class="stack">
      <input type="hidden" name="email" value="${email}">
      <input name="code" class="code-input" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="000000" aria-label="${t(l, "codeLabel")}" autofocus>
      <button class="btn btn-solid">${t(l, "verify")}</button>
    </form>
    <p class="fineprint"><a href="/login">${t(l, "backToLogin")}</a></p>`);
}

export function blockedPage(ctx: PageContext) {
  const l = ctx.lang;
  return card(ctx, t(l, "blockedTitle"), html`
    <h1 class="title-s">${t(l, "blockedTitle")}</h1>
    <p class="muted">${t(l, "blockedText")}</p>
    ${ctx.user?.role === "admin" ? html`<a class="btn btn-solid" href="/admin">${t(l, "goToAdmin")}</a>` : ""}
    <p class="fineprint"><a href="/legal">${t(l, "legalLink")}</a></p>`);
}

export function legalPage(ctx: PageContext) {
  const l = ctx.lang;
  return card(ctx, t(l, "legalTitle"), html`
    <div class="prose" lang="en">
      <h1 class="title-s">${LEGAL.noticeTitle}</h1>
      ${LEGAL.notice.map((p) => html`<p>${p}</p>`)}
      <h2 class="title-xs">${t(l, "legalTitle")}</h2>
      ${LEGAL.legalNotes.map((p) => html`<p>${p}</p>`)}
      <p>${t(l, "cookieLine")}</p>
    </div>
    <p class="fineprint"><a href="/">${t(l, "backHome")}</a></p>`);
}
