import { describe, expect, it } from "vitest";
import { classify, InvalidAnswers, PARAMS } from "../src/cluster/classifier";
import cases from "../classifier/casi_test_v1_1.csv?raw";

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header!.map((h, i) => [h.replace(/^﻿/, ""), r[i] ?? ""])));
}

const TOLERANCE = 0.000001;
const codes = PARAMS.cluster.map((c) => c.codice);
const records = parseCsv(cases);

describe("classificatore v1.1 sui casi di test della specifica", () => {
  it("il file contiene 78 casi", () => expect(records).toHaveLength(78));

  it.each(records.map((r) => [r.RID!, r] as const))("%s", (_rid, rec) => {
    if (rec.atteso_errore) {
      expect(() => classify(rec)).toThrow(InvalidAnswers);
      return;
    }
    const res = classify(rec);
    expect(res.cluster).toBe(rec.atteso_cluster);
    expect(res.cluster2).toBe(rec.atteso_cluster_2);
    expect(res.confidence).toBe(rec.atteso_confidenza);
    expect(res.rule).toBe(rec.atteso_regola);
    expect(res.weakProfile ? "True" : "False").toBe(rec.atteso_profilo_debole);
    expect(res.flags.join(";")).toBe(rec.atteso_segnalazioni);
    expect(Math.abs(res.margin - Number(rec.atteso_margine))).toBeLessThanOrEqual(TOLERANCE);
    for (const c of codes) {
      expect(Math.abs(res.scores[c]! - Number(rec[`atteso_S_${c}`]))).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(res.affinities[c]! - Number(rec[`atteso_AFF_${c}`]))).toBeLessThanOrEqual(TOLERANCE);
    }
  });
});
