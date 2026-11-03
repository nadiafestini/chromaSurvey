import { loadAnswers, toClassifierInput, type AnswerRow } from "../survey/answers";
import { nowIso } from "../lib";
import { classify, CLASSIFIER_VERSION, InvalidAnswers } from "./classifier";

export interface ClusterRow {
  cluster: string | null;
  cluster_name: string | null;
  cluster_2: string | null;
  margin: number | null;
  confidence: string | null;
  weak_profile: number | null;
  rule: string | null;
  affinities_json: string | null;
  flags_json: string | null;
  error: string | null;
}

/** Calcola il cluster e prepara il salvataggio dell'output completo, con la versione del classificatore. */
export function clusterStatements(db: D1Database, responseId: string, rows: AnswerRow[]) {
  const now = nowIso();
  const insert = (values: unknown[]) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO cluster_results (response_id, classifier_version, cluster, cluster_name, cluster_2, margin,
           score_max, confidence, weak_profile, rule, scores_json, affinities_json, flags_json, error, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(responseId, CLASSIFIER_VERSION, ...values, now);
  const flag = (name: string) =>
    db.prepare("INSERT OR IGNORE INTO review_flags (response_id, flag) VALUES (?, ?)").bind(responseId, name);

  try {
    const r = classify(toClassifierInput(rows));
    return [
      insert([
        r.cluster, r.clusterName, r.cluster2, r.margin, r.scoreMax, r.confidence, r.weakProfile ? 1 : 0, r.rule,
        JSON.stringify(r.scores), JSON.stringify(r.affinities), JSON.stringify(r.flags), null
      ]),
      ...r.flags.map(flag)
    ];
  } catch (error) {
    if (!(error instanceof InvalidAnswers)) throw error;
    return [insert([null, null, null, null, null, null, null, null, null, null, null, error.message]), flag("non_classificabile")];
  }
}

export async function loadCluster(db: D1Database, responseId: string): Promise<ClusterRow | null> {
  return db
    .prepare("SELECT * FROM cluster_results WHERE response_id = ? AND classifier_version = ?")
    .bind(responseId, CLASSIFIER_VERSION)
    .first<ClusterRow>();
}

/** Classifica le risposte senza risultato per la versione corrente, ad esempio quelle importate dal pilota. */
export async function recalculateMissing(db: D1Database, limit = 40): Promise<{ done: number; remaining: number }> {
  const { results } = await db
    .prepare(
      `SELECT r.id FROM responses r
       LEFT JOIN cluster_results c ON c.response_id = r.id AND c.classifier_version = ?
       WHERE r.status IN ('completed', 'archived') AND c.response_id IS NULL
       LIMIT ?`
    )
    .bind(CLASSIFIER_VERSION, limit)
    .all<{ id: string }>();
  for (const { id } of results) {
    await db.batch(clusterStatements(db, id, await loadAnswers(db, id)));
  }
  const rest = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM responses r
       LEFT JOIN cluster_results c ON c.response_id = r.id AND c.classifier_version = ?
       WHERE r.status IN ('completed', 'archived') AND c.response_id IS NULL`
    )
    .bind(CLASSIFIER_VERSION)
    .first<{ n: number }>();
  return { done: results.length, remaining: rest?.n ?? 0 };
}
