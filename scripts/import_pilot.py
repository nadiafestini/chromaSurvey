"""Normalizza l'export Forms del pilota e genera un file SQL per D1.

Uso:
    python scripts/import_pilot.py "CLUSTER  CONSUMING MAPPING1-64.xlsx" import/pilot.sql

Il file di output contiene dati personali: la cartella import/ è esclusa dal repo.
Le domande fuori da Survey 1 (Q5, Q6, Q22-Q73) non vengono importate.
Il cluster non viene calcolato qui: lo calcola il motore del sito con "Calcola i cluster" nel report admin.
"""
import json
import pathlib
import sys
import uuid
from collections import Counter
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
NAMESPACE = uuid.UUID("7f1c9a52-3b7e-4c61-9d1a-5e2f8a6c0b11")
VERSION_ID_SUFFIX = "@"

# Correzioni note del pilota.
EMAIL_DOMAIN_FIXES = {"chomavis.com": "chromavis.com"}
ARCHIVED_IDS = {2: "Stessa persona di ID 29: vale ID 29; R02 era già escluso nell'analisi del pilota"}
INTERNAL_DOMAIN = "chromavis.com"
NOTICE_VERSION_PILOT = "forms-pilot"

ID_COL, START_COL, END_COL, EMAIL_COL, PRIVACY_COL = 0, 1, 2, 3, 6


def norm(text):
    s = str(text).replace("\xa0", " ")
    for a, b in (("’", "'"), ("‘", "'"), ("“", '"'), ("”", '"'), ("–", "-"), ("—", "-")):
        s = s.replace(a, b)
    return " ".join(s.split()).strip().lower()


def sql(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def iso(value):
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return datetime.fromisoformat(str(value)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def build_mappings(survey, params):
    """Per ogni campo: testi della domanda, mappa testo->codice, tipo."""
    fields = {}

    def options_map(question_id, options):
        result = {norm(o["en"]): o["code"] for o in options}
        result.update({norm(o["it"]): o["code"] for o in options})
        source = params["intensita"]["domande"].get(question_id) or params["scelte_multiple"].get(question_id)
        for code, opt in (source["opzioni"] if source else {}).items():
            for alias in opt.get("alias", []):
                result[norm(alias)] = int(code)
        return result

    for section in survey["sections"]:
        for q in section["questions"]:
            if q["type"] == "grid":
                scale = {norm(s["en"]): s["code"] for s in q["scale"]}
                for code, opt in params["griglia"]["scala"].items():
                    for alias in opt.get("alias", []):
                        scale[norm(alias)] = int(code)
                for item in q["items"]:
                    if item["code"] == "TRAP":
                        continue  # non esisteva nel pilota
                    fields[(q["id"], item["code"])] = ([norm(item["en"]), norm(item["it"])], scale, "single")
            elif q["type"] == "text":
                fields[(q["id"], "")] = ([norm(q["text"]["en"])], None, "text")
            else:
                texts = [norm(q["text"]["en"]), norm(q["text"]["it"])]
                source = params["intensita"]["domande"].get(q["id"]) or params["scelte_multiple"].get(q["id"])
                if source:
                    texts += [norm(source["en"]), norm(source["it"])]
                fields[(q["id"], "")] = (texts, options_map(q["id"], q["options"]), q["type"])
    return fields


def main():
    import openpyxl

    excel, out_path = sys.argv[1], pathlib.Path(sys.argv[2])
    survey = json.loads((ROOT / "surveys" / "survey1.json").read_text(encoding="utf-8"))
    params = json.loads((ROOT / "classifier" / "classificatore_cluster_v1_1.json").read_text(encoding="utf-8"))
    version_id = f"{survey['id']}{VERSION_ID_SUFFIX}{survey['version']}"

    sheet = openpyxl.load_workbook(excel, data_only=True).active
    rows = list(sheet.iter_rows(values_only=True))
    header = [norm(h) for h in rows[0]]
    data = [r for r in rows[1:] if r[ID_COL] is not None]

    fields = build_mappings(survey, params)
    columns = {}
    for field, (texts, _mapping, _kind) in fields.items():
        hits = [i for i, h in enumerate(header) if h in texts]
        if len(hits) != 1:
            raise SystemExit(f"Colonna per {field} non trovata in modo univoco: {hits}")
        columns[field] = hits[0]

    statements = [
        f"INSERT OR IGNORE INTO surveys (id, title) VALUES ({sql(survey['id'])}, {sql(survey['title']['en'])});",
        "INSERT OR IGNORE INTO survey_versions (id, survey_id, version, definition_json, published_at) VALUES "
        f"({sql(version_id)}, {sql(survey['id'])}, {sql(survey['version'])}, {sql(json.dumps(survey, ensure_ascii=False))}, '2026-11-03T00:00:00.000Z');",
    ]
    answers, consents, audits, users = [], [], [], {}
    responses = []

    for row in data:
        pilot_id = int(row[ID_COL])
        rid = f"R{pilot_id:02d}"
        response_id = f"pilot-{rid}"
        local, domain = str(row[EMAIL_COL]).strip().lower().split("@")
        if domain in EMAIL_DOMAIN_FIXES:
            domain = EMAIL_DOMAIN_FIXES[domain]
            audits.append(("pilot_email_domain_fixed", {"rid": rid}))
        email = f"{local}@{domain}"
        user_id = str(uuid.uuid5(NAMESPACE, email))
        archived = pilot_id in ARCHIVED_IDS
        if archived:
            audits.append(("pilot_response_archived", {"rid": rid, "reason": ARCHIVED_IDS[pilot_id]}))
        name = " ".join(str(row[columns[("Q2", "")]]).split())
        started, completed = iso(row[START_COL]), iso(row[END_COL])
        previous = users.get(user_id)
        # A parità di persona, il nome e la data vengono dalla compilazione valida.
        if previous is None or not archived:
            users[user_id] = (email, name, "internal" if domain == INTERNAL_DOMAIN else "external", started)
        responses.append((response_id, rid, user_id, "archived" if archived else "completed", started, completed))

        for (question, item), (_texts, mapping, kind) in fields.items():
            raw = row[columns[(question, item)]]
            if raw is None or not str(raw).strip():
                continue
            if kind == "text":
                answers.append((response_id, question, "", 0, " ".join(str(raw).split())))
                continue
            parts = [p for p in str(raw).split(";") if p.strip()] if kind == "multi" else [str(raw)]
            codes = []
            for part in parts:
                key = norm(part)
                if key not in mapping:
                    raise SystemExit(f"{rid} {question} {item}: risposta non riconosciuta")
                if mapping[key] not in codes:
                    codes.append(mapping[key])
            answers.extend((response_id, question, item, code, None) for code in codes)

        if not archived:
            action = "confirm" if row[PRIVACY_COL] else "not_recorded"
            consents.append((user_id, action, completed))

    for user_id, (email, name, kind, created) in users.items():
        statements.append(
            "INSERT OR IGNORE INTO users (id, email, name, user_type, lang, created_at) VALUES "
            f"({sql(user_id)}, {sql(email)}, {sql(name)}, {sql(kind)}, 'en', {sql(created)});"
        )
    for response_id, rid, user_id, status, started, completed in responses:
        statements.append(
            "INSERT OR IGNORE INTO responses (id, rid, user_id, survey_id, survey_version_id, source, status, language, started_at, completed_at) VALUES "
            f"({sql(response_id)}, {sql(rid)}, {sql(user_id)}, {sql(survey['id'])}, {sql(version_id)}, 'forms_pilot', {sql(status)}, 'en', {sql(started)}, {sql(completed)});"
        )
    for response_id, question, item, code, text in answers:
        statements.append(
            "INSERT OR IGNORE INTO answers (response_id, question_id, item_code, option_code, text_value) VALUES "
            f"({sql(response_id)}, {sql(question)}, {sql(item)}, {code}, {sql(text)});"
        )
    for user_id, action, occurred in consents:
        statements.append(
            "INSERT INTO consent_events (user_id, action, notice_version, language, source, occurred_at) SELECT "
            f"{sql(user_id)}, {sql(action)}, {sql(NOTICE_VERSION_PILOT)}, 'en', 'forms_pilot', {sql(occurred)} "
            "WHERE NOT EXISTS (SELECT 1 FROM consent_events WHERE user_id = "
            f"{sql(user_id)} AND source = 'forms_pilot');"
        )
    for action, detail in audits:
        statements.append(
            "INSERT INTO audit_log (actor, action, detail_json, occurred_at) VALUES "
            f"('import_pilot', {sql(action)}, {sql(json.dumps(detail, ensure_ascii=False))}, '2026-11-03T00:00:00.000Z');"
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(statements) + "\n", encoding="utf-8")
    # Nessun nome o email nell'output.
    print(f"Righe: {len(responses)}; persone: {len(users)}; risposte: {len(answers)}")
    print("Stati:", dict(Counter(r[3] for r in responses)))
    print("Privacy:", dict(Counter(c[1] for c in consents)))
    print("Correzioni:", dict(Counter(a[0] for a in audits)))


if __name__ == "__main__":
    main()
