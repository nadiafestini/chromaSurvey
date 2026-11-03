"""
CLASSIFICATORE CLUSTER CONSUMATORI MAKE-UP - versione 1.1 (3/11/2026)
Progetto "Cluster Consumatori" - Chromavis, Data Management.

Implementazione di riferimento. Assegna i rispondenti ai 7 cluster della segmentazione a partire dai CODICI
delle risposte, quindi vale per qualunque lingua del questionario. Tutti i parametri sono nel file
classificatore_cluster_v1_1.json; la specifica completa è in specifica_classificatore_v1_1.md.

Rispetto alla v1.0: pesi e soglie identici (stessi risultati), lettura delle risposte per codice invece che
per testo, segnalazioni per la revisione (domanda trappola, chi non si trucca mai, più di 3 risposte).

Solo libreria standard Python (3.8+). Uso:
    python classificatore_cluster_v1_1.py risposte_codificate.csv output.csv
    python classificatore_cluster_v1_1.py --da-forms export_forms.xlsx risposte_codificate.csv   (richiede pandas)
    python classificatore_cluster_v1_1.py --test casi_test_v1_1.csv

Formato di risposte_codificate.csv: una riga per rispondente, colonne
    RID, Q9, Q10, Q11, Q12, A1 ... A18, TRAP (facoltativa), Q14, Q15, Q16, Q17
Risposte singole: un codice intero. Risposte multiple: codici separati da ";" (es. "1;5;11").
"""
import csv
import json
import math
import os
import sys

VERSION = '1.1'
PARAM_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'classificatore_cluster_v1_1.json')
MULTI_BLOCKS = ['Q12', 'Q14', 'Q15', 'Q16', 'Q17']
INT_ORDER = ['Q11', 'Q10', 'Q9']


class RispostaNonValida(ValueError):
    pass


def carica_parametri(path=PARAM_FILE):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


# ---------------- Lettura e validazione delle risposte codificate ----------------

def _codice_singolo(v, ammessi, campo):
    if v is None or str(v).strip() == '':
        raise RispostaNonValida(f'{campo}: risposta mancante')
    try:
        c = int(float(str(v).strip()))
    except ValueError:
        raise RispostaNonValida(f'{campo}: codice non numerico "{v}"')
    if str(c) not in ammessi:
        raise RispostaNonValida(f'{campo}: codice {c} non previsto')
    return c


def _codici_multipli(v, ammessi, campo):
    if isinstance(v, (list, tuple)):
        parti = [str(x) for x in v]
    elif v is None:
        parti = []
    else:
        parti = [x for x in str(v).split(';')]
    codici = []
    for x in parti:
        x = x.strip()
        if x == '':
            continue
        try:
            c = int(float(x))
        except ValueError:
            raise RispostaNonValida(f'{campo}: codice non numerico "{x}"')
        if str(c) not in ammessi:
            raise RispostaNonValida(f'{campo}: codice {c} non previsto')
        if c not in codici:
            codici.append(c)
    return codici


def _vuota(v):
    if v is None:
        return True
    if isinstance(v, (list, tuple)):
        return len(v) == 0
    return str(v).strip() == ''


def valida(risposte, P):
    """Restituisce (risposte normalizzate, segnalazioni). Solleva RispostaNonValida se manca qualcosa."""
    r = {}
    seg = []
    for q in INT_ORDER:
        if _vuota(risposte.get(q)):
            r[q] = None                       # come nella v1.0: la domanda si salta e si segnala
            seg.append(f'risposta_mancante_{q}')
        else:
            r[q] = _codice_singolo(risposte.get(q), P['intensita']['domande'][q]['opzioni'], q)
    if all(r[q] is None for q in INT_ORDER):
        raise RispostaNonValida('Q9, Q10, Q11: tutte mancanti')
    for a in P['griglia']['item']:
        r[a] = _codice_singolo(risposte.get(a), P['griglia']['scala'], a)
    for q in MULTI_BLOCKS:
        d = P['scelte_multiple'][q]
        if _vuota(risposte.get(q)):
            r[q] = []                         # come nella v1.0: punteggio di blocco 0, caso segnalato
            seg.append(f'risposta_mancante_{q}')
            continue
        r[q] = _codici_multipli(risposte.get(q), d['opzioni'], q)
        if len(r[q]) > d['max_risposte']:
            seg.append(f'oltre_{d["max_risposte"]}_risposte_{q}')
    trap = risposte.get('TRAP')
    if trap is not None and str(trap).strip() != '':
        t = _codice_singolo(trap, P['griglia']['scala'], 'TRAP')
        if t != P['griglia']['trap']['risposta_attesa']:
            seg.append('trap_fallita')
    if r['Q9'] is not None and r['Q9'] == P['controlli']['codice_q9_mai']:
        seg.append('non_si_trucca')
    return r, seg


# ---------------- Calcolo ----------------

def punteggi_blocchi(r, P):
    """Punteggio da -1 a +1 per blocco e per cluster; None se il cluster non ha pesi nel blocco."""
    K = len(P['cluster'])
    out = {}

    # 1. Griglia A1-A18: somma(peso x risposta) / somma(|peso|)
    num = [0.0] * K
    den = [0.0] * K
    for a, item in P['griglia']['item'].items():
        x = P['griglia']['scala'][str(r[a])]['valore']
        for k in range(K):
            num[k] += item['pesi'][k] * x
            den[k] += abs(item['pesi'][k])
    out['griglia'] = [num[k] / den[k] for k in range(K)]

    # 2. Scelte multiple: media dei pesi delle opzioni scelte, divisa per 2.
    #    "Nessuna delle precedenti" si ignora se è scelta insieme ad altre opzioni.
    for q in MULTI_BLOCKS:
        d = P['scelte_multiple'][q]
        codici = r[q]
        if len(codici) > 1:
            codici = [c for c in codici if c != d['codice_nessuna']]
        pesi = [d['opzioni'][str(c)]['pesi'] for c in codici]
        s = [sum(w[k] for w in pesi) / len(pesi) / 2 if pesi else 0.0 for k in range(K)]
        attivo = [any(o['pesi'][k] != 0 for o in d['opzioni'].values()) for k in range(K)]
        out[q] = [s[k] if attivo[k] else None for k in range(K)]

    # 3. Intensità: 1 - distanza dal livello atteso / tolleranza, limitato a [-1, +1].
    #    Per gli heavy users stare sopra il livello atteso non penalizza.
    I = P['intensita']
    tot = [0.0] * K
    wsum = 0.0
    for q in INT_ORDER:
        if r[q] is None:
            continue
        dq = I['domande'][q]
        val = dq['opzioni'][str(r[q])]['livello']
        for k in range(K):
            t = dq['target'][k]
            dist = 0.0 if (I['heavy_users'][k] and val >= t) else abs(val - t)
            tot[k] += dq['peso'] * max(-1.0, min(1.0, 1 - dist / I['tolleranza']))
        wsum += dq['peso']
    out['intensita'] = [tot[k] / wsum for k in range(K)]
    return out


def classifica(risposte, P):
    """risposte: dict con chiavi Q9, Q10, Q11, A1..A18, Q12, Q14..Q17 (TRAP facoltativa).
    Restituisce un dict con assegnazione, confidenza, punteggi, affinità e segnalazioni."""
    r, seg = valida(risposte, P)
    cl = [c['codice'] for c in P['cluster']]
    K = len(cl)
    S = P['soglie']
    bs = punteggi_blocchi(r, P)

    # Punteggio finale: media dei blocchi pesata; i blocchi senza pesi per un cluster sono esclusi.
    sc = []
    for k in range(K):
        num = den = 0.0
        for b, w in P['pesi_blocchi'].items():
            v = bs[b][k]
            if v is not None:
                num += w * v
                den += w
        sc.append(num / den)

    ordine = sorted(range(K), key=lambda k: (-sc[k], k))
    top, sec = ordine[0], ordine[1]
    margine = sc[top] - sc[sec]
    regola = 'punteggio massimo'
    if margine < S['spareggio']:
        if bs['griglia'][sec] > bs['griglia'][top]:
            top, sec = sec, top
        regola = 'spareggio (griglia attitudinale)'

    m = max(sc)
    e = [math.exp((s - m) / S['temperatura_affinita']) for s in sc]
    tot = sum(e)
    aff = [x / tot for x in e]

    if margine >= S['margine_netta']:
        conf = 'Netta'
    elif margine >= S['margine_probabile']:
        conf = 'Probabile'
    else:
        conf = 'Incerta'

    res = {'versione': VERSION, 'cluster': cl[top], 'cluster_nome': P['cluster'][top]['nome'],
           'cluster_2': cl[sec], 'margine': margine, 'score_max': sc[top], 'confidenza': conf,
           'profilo_debole': m < S['profilo_debole'], 'regola': regola,
           'punteggi': dict(zip(cl, sc)), 'affinita': dict(zip(cl, aff)), 'segnalazioni': seg}
    return res


# ---------------- File CSV ----------------

COLONNE_INPUT = ['RID', 'Q9', 'Q10', 'Q11', 'Q12'] + [f'A{i}' for i in range(1, 19)] + ['TRAP', 'Q14', 'Q15', 'Q16', 'Q17']


def riga_output(rid, res, cl):
    row = {'RID': rid, 'versione': res['versione'], 'cluster': res['cluster'], 'cluster_nome': res['cluster_nome'], 'cluster_2': res['cluster_2'],
           'margine': round(res['margine'], 6), 'score_max': round(res['score_max'], 6),
           'confidenza': res['confidenza'], 'profilo_debole': res['profilo_debole'], 'regola': res['regola']}
    row.update({f'S_{c}': round(res['punteggi'][c], 6) for c in cl})
    row.update({f'AFF_{c}': round(res['affinita'][c], 6) for c in cl})
    row['segnalazioni'] = ';'.join(res['segnalazioni'])
    row['errore'] = ''
    return row


def classifica_csv(path_in, path_out, P=None):
    P = P or carica_parametri()
    cl = [c['codice'] for c in P['cluster']]
    cols = (['RID', 'versione', 'cluster', 'cluster_nome', 'cluster_2', 'margine', 'score_max', 'confidenza', 'profilo_debole',
             'regola'] + [f'S_{c}' for c in cl] + [f'AFF_{c}' for c in cl] + ['segnalazioni', 'errore'])
    righe = []
    with open(path_in, encoding='utf-8-sig', newline='') as f:
        for rec in csv.DictReader(f):
            try:
                righe.append(riga_output(rec.get('RID'), classifica(rec, P), cl))
            except RispostaNonValida as err:
                righe.append({'RID': rec.get('RID'), 'versione': VERSION, 'errore': str(err)})
    with open(path_out, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(righe)
    return righe


# ---------------- Conversione da export Microsoft Forms (testo -> codici) ----------------

def _norm(s):
    s = str(s).replace('\xa0', ' ')
    for a, b in (('’', "'"), ('‘', "'"), ('“', '"'), ('”', '"'), ('–', '-'), ('—', '-')):
        s = s.replace(a, b)
    return ' '.join(s.split()).strip().lower()


def converti_export_forms(path_xlsx, path_csv, P=None, id_col='ID'):
    """Converte un export Forms (testi in inglese o in italiano) nel formato codificato.
    Domande e opzioni sono riconosciute dai testi del file JSON (più eventuali alias)."""
    import pandas as pd
    P = P or carica_parametri()
    raw = pd.read_excel(path_xlsx)
    hdr = {c: _norm(c) for c in raw.columns}

    domande = {}   # campo -> (testi della domanda, mappa testo->codice, multipla?)
    def mappa(opzioni):
        m = {}
        for cod, o in opzioni.items():
            for t in [o['en'], o['it']] + o.get('alias', []):
                m[_norm(t)] = int(cod)
        return m
    for q, d in P['intensita']['domande'].items():
        domande[q] = ([d['en'], d['it']], mappa(d['opzioni']), False)
    scala = mappa(P['griglia']['scala'])
    for a, it in P['griglia']['item'].items():
        domande[a] = ([it['en'], it['it']], scala, False)
    domande['TRAP'] = ([P['griglia']['trap']['en'], P['griglia']['trap']['it']], scala, False)
    for q, d in P['scelte_multiple'].items():
        domande[q] = ([d['en'], d['it']], mappa(d['opzioni']), True)

    out = pd.DataFrame({'RID': ['R%02d' % int(i) for i in raw[id_col]]})
    for campo, (testi, m, multipla) in domande.items():
        tn = [_norm(t) for t in testi]
        hits = [c for c, h in hdr.items() if h in tn]
        if len(hits) != 1:
            if campo == 'TRAP' and not hits:
                out['TRAP'] = ''
                continue
            raise ValueError(f'Colonna per {campo} non trovata in modo univoco (trovate: {hits})')
        def conv(v):
            if not isinstance(v, str) or not v.strip():
                return ''
            parti = [x for x in v.split(';') if x.strip()] if multipla else [v]
            codici = []
            for x in parti:
                k = _norm(x)
                if k not in m:
                    raise ValueError(f'{campo}: risposta non riconosciuta "{x.strip()}"')
                codici.append(str(m[k]))
            return ';'.join(codici)
        out[campo] = raw[hits[0]].map(conv).values
    out = out[COLONNE_INPUT]
    out.to_csv(path_csv, index=False, encoding='utf-8')
    return out


# ---------------- Verifica sui casi di test ----------------

def verifica_casi_test(path_test, P=None, tol=1e-6):
    """Ricalcola i casi di casi_test_v1_1.csv e li confronta con le colonne atteso_*."""
    P = P or carica_parametri()
    cl = [c['codice'] for c in P['cluster']]
    errori = []
    n = 0
    with open(path_test, encoding='utf-8-sig', newline='') as f:
        for rec in csv.DictReader(f):
            n += 1
            rid = rec['RID']
            try:
                res = classifica(rec, P)
            except RispostaNonValida as err:
                if not rec['atteso_errore']:
                    errori.append(f'{rid}: errore inatteso ({err})')
                continue
            if rec['atteso_errore']:
                errori.append(f'{rid}: atteso errore, ottenuto {res["cluster"]}')
                continue
            for campo in ('cluster', 'cluster_2', 'confidenza', 'regola'):
                if str(res[campo]) != rec['atteso_' + campo]:
                    errori.append(f'{rid}: {campo} {res[campo]} invece di {rec["atteso_" + campo]}')
            if str(res['profilo_debole']) != rec['atteso_profilo_debole']:
                errori.append(f'{rid}: profilo_debole diverso')
            if ';'.join(res['segnalazioni']) != rec['atteso_segnalazioni']:
                errori.append(f'{rid}: segnalazioni "{";".join(res["segnalazioni"])}" invece di "{rec["atteso_segnalazioni"]}"')
            valori = [('margine', res['margine'])] + [(f'S_{c}', res['punteggi'][c]) for c in cl] + \
                     [(f'AFF_{c}', res['affinita'][c]) for c in cl]
            for nome, v in valori:
                if abs(v - float(rec['atteso_' + nome])) > tol:
                    errori.append(f'{rid}: {nome} {v:.6f} invece di {rec["atteso_" + nome]}')
    return n, errori


if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) == 2 and a[0] == '--test':
        n, err = verifica_casi_test(a[1])
        print(f'Casi verificati: {n}. Differenze: {len(err)}')
        for e in err:
            print('  ' + e)
        sys.exit(1 if err else 0)
    if len(a) == 3 and a[0] == '--da-forms':
        df = converti_export_forms(a[1], a[2])
        print(f'Convertiti {len(df)} rispondenti in {a[2]}')
    elif len(a) == 2:
        righe = classifica_csv(a[0], a[1])
        from collections import Counter
        ok = [r for r in righe if not r.get('errore')]
        print(f'Classificati {len(ok)} rispondenti su {len(righe)}')
        for c, n in Counter(r['cluster_nome'] for r in ok).most_common():
            print(f'  {c}: {n}')
        for r in righe:
            if r.get('errore'):
                print(f'  ERRORE {r["RID"]}: {r["errore"]}')
            elif r['segnalazioni']:
                print(f'  Da rivedere {r["RID"]}: {r["segnalazioni"]}')
    else:
        print(__doc__)
