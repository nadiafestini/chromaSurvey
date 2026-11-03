// Classificatore cluster v1.1: traduzione di classifier/classificatore_cluster_v1_1.py.
// I parametri arrivano solo dal JSON. Pesi e soglie non vanno modificati qui (specifica, sezione 1).
import raw from "../../classifier/classificatore_cluster_v1_1.json";

interface Weighted { pesi: number[] }
interface Params {
  versione: string;
  cluster: { codice: string; nome: string; quota_mercato: number }[];
  pesi_blocchi: Record<string, number>;
  griglia: {
    scala: Record<string, { valore: number }>;
    item: Record<string, Weighted>;
    trap: { risposta_attesa: number };
  };
  scelte_multiple: Record<string, { max_risposte: number; codice_nessuna: number; opzioni: Record<string, Weighted> }>;
  intensita: {
    tolleranza: number;
    heavy_users: boolean[];
    domande: Record<string, { peso: number; target: number[]; opzioni: Record<string, { livello: number }> }>;
  };
  soglie: {
    temperatura_affinita: number;
    spareggio: number;
    margine_netta: number;
    margine_probabile: number;
    profilo_debole: number;
  };
  controlli: { codice_q9_mai: number };
}

export const PARAMS = raw as unknown as Params;
export const CLASSIFIER_VERSION = PARAMS.versione;

const MULTI_BLOCKS = ["Q12", "Q14", "Q15", "Q16", "Q17"] as const;
const INT_ORDER = ["Q11", "Q10", "Q9"] as const;

export type RawAnswers = Record<string, unknown>;

export interface ClusterOutput {
  version: string;
  cluster: string;
  clusterName: string;
  cluster2: string;
  margin: number;
  scoreMax: number;
  confidence: "Netta" | "Probabile" | "Incerta";
  weakProfile: boolean;
  rule: "punteggio massimo" | "spareggio (griglia attitudinale)";
  scores: Record<string, number>;
  affinities: Record<string, number>;
  flags: string[];
}

export class InvalidAnswers extends Error {}

function parseCode(value: unknown, field: string): number {
  const text = String(value).trim();
  const num = Number(text);
  if (text === "" || !Number.isFinite(num)) throw new InvalidAnswers(`${field}: codice non numerico "${text}"`);
  return Math.trunc(num);
}

function singleCode(value: unknown, allowed: Record<string, unknown>, field: string): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new InvalidAnswers(`${field}: risposta mancante`);
  }
  const code = parseCode(value, field);
  if (!(String(code) in allowed)) throw new InvalidAnswers(`${field}: codice ${code} non previsto`);
  return code;
}

function multiCodes(value: unknown, allowed: Record<string, unknown>, field: string): number[] {
  const parts = Array.isArray(value) ? value.map(String) : value == null ? [] : String(value).split(";");
  const codes: number[] = [];
  for (const part of parts) {
    if (part.trim() === "") continue;
    const code = parseCode(part, field);
    if (!(String(code) in allowed)) throw new InvalidAnswers(`${field}: codice ${code} non previsto`);
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return String(value).trim() === "";
}

interface Normalized {
  single: Record<string, number | null>;
  grid: Record<string, number>;
  multi: Record<string, number[]>;
  flags: string[];
}

function validate(answers: RawAnswers, P: Params): Normalized {
  const single: Record<string, number | null> = {};
  const flags: string[] = [];
  for (const q of INT_ORDER) {
    if (isEmpty(answers[q])) {
      single[q] = null;
      flags.push(`risposta_mancante_${q}`);
    } else {
      single[q] = singleCode(answers[q], P.intensita.domande[q]!.opzioni, q);
    }
  }
  if (INT_ORDER.every((q) => single[q] === null)) throw new InvalidAnswers("Q9, Q10, Q11: tutte mancanti");

  const grid: Record<string, number> = {};
  for (const item of Object.keys(P.griglia.item)) grid[item] = singleCode(answers[item], P.griglia.scala, item);

  const multi: Record<string, number[]> = {};
  for (const q of MULTI_BLOCKS) {
    const d = P.scelte_multiple[q]!;
    if (isEmpty(answers[q])) {
      multi[q] = [];
      flags.push(`risposta_mancante_${q}`);
      continue;
    }
    multi[q] = multiCodes(answers[q], d.opzioni, q);
    if (multi[q]!.length > d.max_risposte) flags.push(`oltre_${d.max_risposte}_risposte_${q}`);
  }

  if (!isEmpty(answers.TRAP)) {
    const trap = singleCode(answers.TRAP, P.griglia.scala, "TRAP");
    if (trap !== P.griglia.trap.risposta_attesa) flags.push("trap_fallita");
  }
  if (single.Q9 === P.controlli.codice_q9_mai) flags.push("non_si_trucca");
  return { single, grid, multi, flags };
}

type Block = (number | null)[];

function blockScores(n: Normalized, P: Params): Record<string, Block> {
  const K = P.cluster.length;
  const range = [...Array(K).keys()];
  const out: Record<string, Block> = {};

  // Griglia: somma(peso x risposta) / somma(|peso|)
  const num = range.map(() => 0);
  const den = range.map(() => 0);
  for (const [code, item] of Object.entries(P.griglia.item)) {
    const x = P.griglia.scala[String(n.grid[code])]!.valore;
    for (const k of range) {
      num[k]! += item.pesi[k]! * x;
      den[k]! += Math.abs(item.pesi[k]!);
    }
  }
  out.griglia = range.map((k) => num[k]! / den[k]!);

  // Multiple: media dei pesi delle opzioni scelte, divisa per 2.
  // "None of the above" si ignora se è scelta insieme ad altre opzioni.
  for (const q of MULTI_BLOCKS) {
    const d = P.scelte_multiple[q]!;
    let codes = n.multi[q]!;
    if (codes.length > 1) codes = codes.filter((c) => c !== d.codice_nessuna);
    const weights = codes.map((c) => d.opzioni[String(c)]!.pesi);
    const options = Object.values(d.opzioni);
    out[q] = range.map((k) => {
      if (!options.some((o) => o.pesi[k] !== 0)) return null;
      if (weights.length === 0) return 0;
      return weights.reduce((sum, w) => sum + w[k]!, 0) / weights.length / 2;
    });
  }

  // Intensità: per gli heavy user stare sopra il livello atteso non penalizza.
  const I = P.intensita;
  const total = range.map(() => 0);
  let weightSum = 0;
  for (const q of INT_ORDER) {
    const answer = n.single[q];
    if (answer === null || answer === undefined) continue;
    const dq = I.domande[q]!;
    const level = dq.opzioni[String(answer)]!.livello;
    for (const k of range) {
      const target = dq.target[k]!;
      const dist = I.heavy_users[k] && level >= target ? 0 : Math.abs(level - target);
      total[k]! += dq.peso * Math.max(-1, Math.min(1, 1 - dist / I.tolleranza));
    }
    weightSum += dq.peso;
  }
  out.intensita = range.map((k) => total[k]! / weightSum);
  return out;
}

export function classify(answers: RawAnswers, P: Params = PARAMS): ClusterOutput {
  const n = validate(answers, P);
  const codes = P.cluster.map((c) => c.codice);
  const range = [...codes.keys()];
  const S = P.soglie;
  const blocks = blockScores(n, P);

  const scores = range.map((k) => {
    let num = 0;
    let den = 0;
    for (const [block, weight] of Object.entries(P.pesi_blocchi)) {
      const value = blocks[block]![k];
      if (value !== null && value !== undefined) {
        num += weight * value;
        den += weight;
      }
    }
    return num / den;
  });

  const order = [...range].sort((a, b) => scores[b]! - scores[a]! || a - b);
  let top = order[0]!;
  let second = order[1]!;
  const margin = scores[top]! - scores[second]!;
  let rule: ClusterOutput["rule"] = "punteggio massimo";
  if (margin < S.spareggio) {
    if (blocks.griglia![second]! > blocks.griglia![top]!) [top, second] = [second, top];
    rule = "spareggio (griglia attitudinale)";
  }

  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / S.temperatura_affinita));
  const expSum = exps.reduce((a, b) => a + b, 0);

  return {
    version: CLASSIFIER_VERSION,
    cluster: codes[top]!,
    clusterName: P.cluster[top]!.nome,
    cluster2: codes[second]!,
    margin,
    scoreMax: scores[top]!,
    confidence: margin >= S.margine_netta ? "Netta" : margin >= S.margine_probabile ? "Probabile" : "Incerta",
    weakProfile: max < S.profilo_debole,
    rule,
    scores: Object.fromEntries(range.map((k) => [codes[k]!, scores[k]!])),
    affinities: Object.fromEntries(range.map((k) => [codes[k]!, exps[k]! / expSum])),
    flags: n.flags
  };
}
