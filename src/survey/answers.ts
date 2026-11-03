import type { Question, Section } from "./definition";
import { QUESTIONS, SURVEY } from "./definition";

export interface AnswerRow {
  question_id: string;
  item_code: string;
  option_code: number;
  text_value: string | null;
}

export type FormValues = Record<string, string[]>;

export class InvalidSubmission extends Error {}

export function formToValues(form: FormData): FormValues {
  const values: FormValues = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") (values[key] ??= []).push(value);
  }
  return values;
}

export function rowsToValues(rows: AnswerRow[]): FormValues {
  const values: FormValues = {};
  for (const row of rows) {
    const key = row.item_code ? `${row.question_id}.${row.item_code}` : row.question_id;
    (values[key] ??= []).push(row.text_value ?? String(row.option_code));
  }
  return values;
}

function parseOption(value: string, allowed: number[], field: string): number {
  const code = Number(value);
  if (!Number.isInteger(code) || !allowed.includes(code)) throw new InvalidSubmission(`${field}: codice non previsto`);
  return code;
}

/**
 * Converte le risposte di un blocco in righe, controllando codici, massimo risposte e "None" esclusivo.
 * Le domande non ancora risposte sono ammesse: la completezza si controlla con missingQuestions.
 */
export function parseQuestions(questions: Question[], values: FormValues): AnswerRow[] {
  const rows: AnswerRow[] = [];
  for (const q of questions) {
    if (q.type === "text") {
      const text = (values[q.id]?.[0] ?? "").trim();
      if (text.length > 200) throw new InvalidSubmission(`${q.id}: testo troppo lungo`);
      if (text) rows.push({ question_id: q.id, item_code: "", option_code: 0, text_value: text });
    } else if (q.type === "single") {
      const given = values[q.id] ?? [];
      if (given.length > 1) throw new InvalidSubmission(`${q.id}: una sola risposta`);
      const allowed = q.options.map((o) => o.code);
      for (const v of given) {
        rows.push({ question_id: q.id, item_code: "", option_code: parseOption(v, allowed, q.id), text_value: null });
      }
    } else if (q.type === "multi") {
      const allowed = q.options.map((o) => o.code);
      const codes = [...new Set((values[q.id] ?? []).map((v) => parseOption(v, allowed, q.id)))];
      if (q.max && codes.length > q.max) throw new InvalidSubmission(`${q.id}: massimo ${q.max} risposte`);
      if (codes.includes(q.noneCode) && codes.length > 1) throw new InvalidSubmission(`${q.id}: "None" è esclusiva`);
      for (const code of codes) rows.push({ question_id: q.id, item_code: "", option_code: code, text_value: null });
    } else {
      const allowed = q.scale.map((o) => o.code);
      for (const item of q.items) {
        const given = values[`${q.id}.${item.code}`] ?? [];
        if (given.length > 1) throw new InvalidSubmission(`${q.id}.${item.code}: una sola risposta`);
        for (const v of given) {
          rows.push({ question_id: q.id, item_code: item.code, option_code: parseOption(v, allowed, q.id), text_value: null });
        }
      }
    }
  }
  return rows;
}

/** Domande senza risposta completa. Tutte le domande sono obbligatorie. */
export function missingQuestions(questions: Question[], rows: AnswerRow[]): string[] {
  return questions
    .filter((q) => {
      const own = rows.filter((r) => r.question_id === q.id);
      return q.type === "grid" ? q.items.some((i) => !own.some((r) => r.item_code === i.code)) : own.length === 0;
    })
    .map((q) => q.id);
}

/** Salva le risposte di una sezione sostituendo quelle precedenti. */
export function saveSectionStatements(db: D1Database, responseId: string, section: Section, rows: AnswerRow[]) {
  const ids = section.questions.map((q) => q.id);
  return [
    db
      .prepare(`DELETE FROM answers WHERE response_id = ? AND question_id IN (${ids.map(() => "?").join(",")})`)
      .bind(responseId, ...ids),
    ...rows.map((r) =>
      db
        .prepare("INSERT INTO answers (response_id, question_id, item_code, option_code, text_value) VALUES (?, ?, ?, ?, ?)")
        .bind(responseId, r.question_id, r.item_code, r.option_code, r.text_value)
    )
  ];
}

export async function loadAnswers(db: D1Database, responseId: string): Promise<AnswerRow[]> {
  const { results } = await db
    .prepare("SELECT question_id, item_code, option_code, text_value FROM answers WHERE response_id = ?")
    .bind(responseId)
    .all<AnswerRow>();
  return results;
}

/** Input del classificatore: Q9, A1, TRAP, Q12 = [..] */
export function toClassifierInput(rows: AnswerRow[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const types = new Map(QUESTIONS.map((q) => [q.id, q.type]));
  for (const row of rows) {
    const type = types.get(row.question_id);
    if (type === "single") input[row.question_id] = row.option_code;
    else if (type === "grid") input[row.item_code] = row.option_code;
    else if (type === "multi") ((input[row.question_id] ??= []) as number[]).push(row.option_code);
  }
  return input;
}

export const SECTIONS = SURVEY.sections;
