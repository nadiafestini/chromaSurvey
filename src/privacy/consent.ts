import legal from "../../legal/legal.json";
import type { Lang } from "../env";
import { nowIso } from "../lib";

export const LEGAL = legal;

export type ConsentState = "confirmed" | "needed" | "revoked";

export interface ConsentEvent {
  action: "confirm" | "revoke" | "unblock" | "not_recorded";
  notice_version: string;
  occurred_at: string;
}

export async function lastConsentEvent(db: D1Database, userId: string): Promise<ConsentEvent | null> {
  return db
    .prepare("SELECT action, notice_version, occurred_at FROM consent_events WHERE user_id = ? ORDER BY id DESC LIMIT 1")
    .bind(userId)
    .first<ConsentEvent>();
}

/** Vale solo una conferma recente sulla versione in vigore dell'informativa. */
export async function consentState(db: D1Database, userId: string): Promise<ConsentState> {
  const last = await lastConsentEvent(db, userId);
  if (last?.action === "revoke") return "revoked";
  return last?.action === "confirm" && last.notice_version === LEGAL.version ? "confirmed" : "needed";
}

export function recordConsent(db: D1Database, userId: string, action: ConsentEvent["action"], lang: Lang, source: "platform" | "admin") {
  return db
    .prepare("INSERT INTO consent_events (user_id, action, notice_version, language, source, occurred_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(userId, action, LEGAL.version, lang, source, nowIso());
}
