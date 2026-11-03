"""Genera surveys/survey1.json dalle due Proposte (EN e IT).

Uso: python scripts/build_survey.py "Proposta Survey 1 - ENG.md" "Proposta Survey 1 - ITA.md"
Si ferma se domande o codici non coincidono tra le due lingue.
"""
import json
import pathlib
import re
import sys


def parse(path):
    md = pathlib.Path(path).read_text(encoding="utf-8")
    out = {}
    pattern = r"\*\*(Q\d+)\.\s*(.*?)\*\*(.*?)(?=\n\*\*Q\d+\.|\n## |\Z)"
    for m in re.finditer(pattern, md, re.S):
        rows = re.findall(r"^\| ?(\d+|A\d+|TRAP) ?\| (.+?) \|$", m.group(3), re.M)
        out[m.group(1)] = {"text": " ".join(m.group(2).split()), "rows": rows}
    return out


def merge_rows(q, en, it):
    if [c for c, _ in en] != [c for c, _ in it]:
        raise SystemExit(f"{q}: i codici non coincidono tra EN e IT")
    return [{"code": c, "en": e.strip(), "it": i.strip()} for (c, e), (_, i) in zip(en, it)]


# Sezioni e tipi: i codici delle domande restano quelli originali.
SECTIONS = [
    ("about", "About you", "Su di te", ["Q2", "Q3", "Q4", "Q7", "Q8"]),
    ("habits", "Your make-up habits", "Le tue abitudini", ["Q9", "Q10", "Q11", "Q12"]),
    ("attitudes", "Your attitudes", "I tuoi atteggiamenti", ["Q13"]),
    ("choices", "How you choose", "Come scegli", ["Q14", "Q15", "Q16", "Q17"]),
    ("profile", "Your make-up profile", "Il tuo profilo make-up", ["Q18", "Q19", "Q20", "Q21"]),
]
MULTI_MAX = {"Q12": 3, "Q14": 3, "Q15": 3, "Q16": 3, "Q17": 3, "Q21": None}
TRAP_AFTER = "A9"  # posizione della trappola nella griglia, scelta a piacere dalla specifica


def question(q, en, it):
    text = {"en": en[q]["text"], "it": it[q]["text"]}
    if q == "Q2":
        return {"id": q, "type": "text", "text": text}
    rows = merge_rows(q, en[q]["rows"], it[q]["rows"])
    if q == "Q13":
        scale = [{"code": int(r["code"]), "en": r["en"], "it": r["it"]} for r in rows if r["code"].isdigit()]
        items = [r for r in rows if not r["code"].isdigit()]
        trap = next(r for r in items if r["code"] == "TRAP")
        items = [r for r in items if r["code"] != "TRAP"]
        pos = [r["code"] for r in items].index(TRAP_AFTER) + 1
        items.insert(pos, trap)
        return {"id": q, "type": "grid", "text": text, "scale": scale, "items": items}
    options = [{"code": int(r["code"]), "en": r["en"], "it": r["it"]} for r in rows]
    if q in MULTI_MAX:
        last = options[-1]
        result = {"id": q, "type": "multi", "text": text, "noneCode": last["code"], "options": options}
        if MULTI_MAX[q]:
            result["max"] = MULTI_MAX[q]
        return result
    return {"id": q, "type": "single", "text": text, "options": options}


def main():
    en, it = parse(sys.argv[1]), parse(sys.argv[2])
    if list(en) != list(it):
        raise SystemExit("Le domande non coincidono tra EN e IT")
    used = [q for s in SECTIONS for q in s[3]]
    if sorted(used) != sorted(en):
        raise SystemExit(f"Domande non assegnate a una sezione: {set(en) ^ set(used)}")
    survey = {
        "id": "cluster-segmentation",
        "version": "1.0",
        "title": {"en": "Cluster segmentation", "it": "Cluster segmentation"},
        "sections": [
            {"id": sid, "title": {"en": te, "it": ti}, "questions": [question(q, en, it) for q in qs]}
            for sid, te, ti, qs in SECTIONS
        ],
    }
    out = pathlib.Path(__file__).resolve().parent.parent / "surveys" / "survey1.json"
    out.write_text(json.dumps(survey, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Scritto {out}: {len(used)} domande")


if __name__ == "__main__":
    main()
