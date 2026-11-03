import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach } from "vitest";

// Ogni test parte da tabelle vuote.
const TABLES = [
  "review_flags", "cluster_results", "answers", "responses", "survey_versions", "surveys",
  "sessions", "otp_codes", "oidc_states", "rate_limits", "audit_log"
];

beforeEach(async () => {
  const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  await e.DB.batch([
    e.DB.prepare("DROP TRIGGER IF EXISTS consent_events_no_delete"),
    e.DB.prepare("DELETE FROM consent_events"),
    e.DB.prepare(`CREATE TRIGGER consent_events_no_delete BEFORE DELETE ON consent_events
      BEGIN SELECT RAISE(ABORT, 'consent_events is append-only'); END`),
    ...TABLES.map((t) => e.DB.prepare(`DELETE FROM ${t}`)),
    e.DB.prepare("DELETE FROM users")
  ]);
});
