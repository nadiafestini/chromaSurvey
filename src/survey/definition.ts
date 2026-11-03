import raw from "../../surveys/survey1.json";
import type { Lang } from "../env";
import { nowIso } from "../lib";

export type Localized = Record<Lang, string>;
export interface Option extends Localized { code: number }
export interface GridItem extends Localized { code: string }

interface Base { id: string; text: Localized }
export interface TextQuestion extends Base { type: "text" }
export interface SingleQuestion extends Base { type: "single"; options: Option[] }
export interface MultiQuestion extends Base { type: "multi"; options: Option[]; noneCode: number; max?: number }
export interface GridQuestion extends Base { type: "grid"; scale: Option[]; items: GridItem[] }
export type Question = TextQuestion | SingleQuestion | MultiQuestion | GridQuestion;

export interface Section { id: string; title: Localized; questions: Question[] }
export interface Survey { id: string; version: string; title: Localized; sections: Section[] }

export const SURVEY = raw as unknown as Survey;
export const SURVEY_VERSION_ID = `${SURVEY.id}@${SURVEY.version}`;
export const QUESTIONS = SURVEY.sections.flatMap((s) => s.questions);

/** Numero mostrato a video: progressivo, mentre i codici originali (Q9...) restano fissi nei dati. */
export const DISPLAY_NUMBER = new Map(QUESTIONS.map((q, i) => [q.id, i + 1]));

const questionNumber = (questionId: string) => questionId.replace(/^Q/, "");
const letter = (code: number) => String.fromCharCode(96 + code);

/** Indice stabile della risposta, uguale in ogni lingua: 12.a, 13.A1.a */
export const answerIndex = (questionId: string, code: number, item = "") =>
  item ? `${questionNumber(questionId)}.${item}.${letter(code)}` : `${questionNumber(questionId)}.${letter(code)}`;

export async function ensureSurveyVersion(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO surveys (id, title) VALUES (?, ?)").bind(SURVEY.id, SURVEY.title.en),
    db
      .prepare("INSERT OR IGNORE INTO survey_versions (id, survey_id, version, definition_json, published_at) VALUES (?, ?, ?, ?, ?)")
      .bind(SURVEY_VERSION_ID, SURVEY.id, SURVEY.version, JSON.stringify(SURVEY), nowIso())
  ]);
}
