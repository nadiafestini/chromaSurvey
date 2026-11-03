# Classificatore cluster consumatori make-up: specifica v1.1

*Versione 1.1 del 3/11/2026. Chromavis, Data Management, progetto "Cluster Consumatori".*

Questo documento serve a implementare il classificatore dentro la piattaforma online della survey, in qualunque linguaggio. Il classificatore assegna ogni rispondente a uno dei 7 cluster di consumatori make-up a partire dai **codici** delle risposte, quindi funziona allo stesso modo con il questionario in inglese e in italiano.

## 1. Contenuto del pacchetto

| File | Contenuto |
|---|---|
| `specifica_classificatore_v1_1.md` | Questo documento: dati in ingresso, calcolo, output, verifica |
| `classificatore_cluster_v1_1.json` | Tutti i parametri (pesi, soglie) e i testi in inglese e italiano di domande e opzioni, indicizzati per codice. È l'**unica fonte dei parametri** |
| `classificatore_cluster_v1_1.py` | Implementazione di riferimento in Python, solo libreria standard. Serve per le analisi fuori piattaforma e come termine di confronto |
| `casi_test_v1_1.csv` | 78 casi con risposte codificate e risultato atteso: i 64 rispondenti del pilota interno e 14 casi costruiti apposta |

**Regole da rispettare:**

1. **Leggere i parametri dal JSON**, senza ricopiarli nel codice. Se il JSON cambia, cambia la versione.
2. **Non modificare pesi né soglie.** Ogni modifica richiede una nuova versione (v1.2, v2.0…), decisa dal Data Management.
3. **L'implementazione è corretta solo se riproduce tutti i casi di test** (sezione 8).

## 2. Domande usate

Il classificatore usa 9 domande del questionario *CLUSTER & CONSUMING MAPPING*. I testi esatti in inglese (`en`) e italiano (`it`) di domande e opzioni sono nel JSON, e la piattaforma dovrebbe prenderli da lì.

| Campo | Domanda | Tipo | Dove sta nel JSON |
|---|---|---|---|
| `Q9` | Frequenza d'uso del make-up | Singola, codici 1–7 | `intensita.domande.Q9` |
| `Q10` | Frequenza d'acquisto | Singola, codici 1–5 | `intensita.domande.Q10` |
| `Q11` | Spesa annua | Singola, codici 1–5 | `intensita.domande.Q11` |
| `Q12` | Significato del make-up | Multipla, max 3, codici 1–11 | `scelte_multiple.Q12` |
| `A1`…`A18` | Griglia attitudinale Q13, una risposta per affermazione | Scala, codici 1–5 | `griglia.item`, scala in `griglia.scala` |
| `TRAP` | Domanda trappola dentro la griglia Q13 | Scala, codici 1–5 | `griglia.trap` |
| `Q14` | Orientamento d'acquisto | Multipla, max 3, codici 1–15 | `scelte_multiple.Q14` |
| `Q15` | Criteri di valutazione | Multipla, max 3, codici 1–14 | `scelte_multiple.Q15` |
| `Q16` | Tipologia di brand | Multipla, max 3, codici 1–7 | `scelte_multiple.Q16` |
| `Q17` | Ingredienti | Multipla, max 3, codici 1–9 | `scelte_multiple.Q17` |

Nella scala della griglia il codice 1 corrisponde a "Strongly agree" e il codice 5 a "Strongly disagree". In ogni domanda multipla l'ultimo codice è "None of the above" (`codice_nessuna` nel JSON).

**Cosa deve garantire la piattaforma:**

- tutte le domande obbligatorie;
- al massimo 3 risposte nelle domande multiple;
- "None of the above" esclusivo, cioè non combinabile con altre opzioni;
- la riga `TRAP` inserita nella griglia Q13, in una posizione a scelta tra gli item;
- salvataggio dei **codici** delle risposte, non dei testi.

Il classificatore tollera comunque i casi in cui questi vincoli non sono rispettati, ad esempio con dati importati da Microsoft Forms, e li segnala (sezione 5).

## 3. Dati in ingresso

Un rispondente è un oggetto con i codici delle risposte. Le risposte singole sono interi; le multiple sono liste di interi. Esempio:

```json
{
  "RID": "ESEMPIO",
  "Q9": 1, "Q10": 4, "Q11": 3,
  "Q12": [1, 2, 8],
  "A1": 1, "A2": 1, "A3": 2, "A4": 5, "A5": 4, "A6": 4, "A7": 4, "A8": 3, "A9": 2,
  "A10": 2, "A11": 2, "A12": 2, "A13": 3, "A14": 3, "A15": 3, "A16": 3, "A17": 3, "A18": 2,
  "TRAP": 1,
  "Q14": [1, 3, 12], "Q15": [2, 5, 13], "Q16": [5, 6], "Q17": [2, 6]
}
```

In formato CSV, che è quello dell'implementazione di riferimento e dei casi di test, c'è una riga per rispondente con le colonne `RID, Q9, Q10, Q11, Q12, A1…A18, TRAP, Q14, Q15, Q16, Q17`. Le risposte multiple sono codici separati da punto e virgola, ad esempio `1;5;11`. Una cella vuota indica una risposta mancante.

## 4. Calcolo

I 7 cluster sono, nell'ordine del JSON (`cluster`): BTP, BEE, ESS, SOL, HER, MSC, MEM. Tutti i vettori di pesi e target nel JSON seguono questo ordine. Per ogni cluster *k* si calcolano 7 punteggi di blocco, ciascuno tra −1 e +1, poi una media pesata.

### 4.1 Griglia (blocco `griglia`)

Ogni risposta si converte nel valore della scala, `griglia.scala[codice].valore`: +1, +0,5, 0, −0,5, −1. Con *x*ᵢ il valore della risposta all'item *i* e *w*ᵢₖ il peso dell'item *i* per il cluster *k*:

```
griglia[k] = Σᵢ (wᵢₖ × xᵢ) / Σᵢ |wᵢₖ|        (i = A1…A18)
```

La riga `TRAP` non entra nel calcolo.

### 4.2 Domande multiple (blocchi `Q12`, `Q14`, `Q15`, `Q16`, `Q17`)

1. Se sono scelti più codici, si scarta `codice_nessuna`. Se è scelto solo quello, resta.
2. Il punteggio è la media dei pesi delle opzioni rimaste, divisa per 2:

```
blocco[k] = (Σ pesi[opzione][k] / numero di opzioni) / 2
```

3. Se la risposta manca, il punteggio è 0 per tutti i cluster.
4. Se un cluster ha peso 0 in **tutte** le opzioni della domanda, "None of the above" compresa, il blocco **non esiste** per quel cluster e non entra nella sua media (passo 4.4). Con i parametri v1.1 non succede mai, ma la regola va implementata perché dipende dai parametri.

L'opzione "None of the above" di Q17 ha un peso (+1 per ESS): è l'unico caso in cui "Nessuna" pesa. Il caso di test T01 lo verifica.

### 4.3 Intensità (blocco `intensita`)

Per Q11, Q10 e Q9 si legge il livello dell'opzione scelta, `opzioni[codice].livello`, su una scala da 0 a 4. Per ogni domanda *q* con peso *p_q* e livello atteso del cluster *t_qk*:

```
d = |livello − t_qk|
se il cluster è heavy user (heavy_users[k] = true) e livello ≥ t_qk:  d = 0
contributo = p_q × limita(1 − d / tolleranza, −1, +1)

intensita[k] = Σ contributi / Σ p_q        (somma sulle domande con risposta)
```

I pesi sono 0,5 per Q11, 0,3 per Q10 e 0,2 per Q9; la tolleranza è 1,5. Se una delle tre domande manca, si usano le altre. Se mancano tutte e tre, il rispondente non è classificabile.

### 4.4 Punteggio finale

```
S[k] = Σ_b (peso_b × blocco_b[k]) / Σ_b peso_b
```

Le somme sono sui blocchi esistenti per il cluster *k*. I pesi sono in `pesi_blocchi`: griglia 35, Q12 12, Q14 12, Q15 10, Q16 8, Q17 8, intensità 15.

### 4.5 Assegnazione

1. Si ordinano i cluster per `S` decrescente. A parità esatta vince il cluster che viene prima nell'ordine del JSON. Il primo è `top`, il secondo `sec`.
2. `margine = S[top] − S[sec]`.
3. **Spareggio:** se `margine < soglie.spareggio` (0,02), si confrontano i punteggi della sola griglia. Se `griglia[sec] > griglia[top]`, i due si scambiano. La regola registrata diventa "spareggio (griglia attitudinale)", altrimenti resta "punteggio massimo".
4. `cluster = top`, `cluster_2 = sec`, `score_max = S[top]`, con `top` dopo l'eventuale scambio.
5. **Confidenza**, sul margine calcolato al punto 2:
   - `Netta` se margine ≥ 0,10 (`margine_netta`);
   - `Probabile` se margine ≥ 0,05 (`margine_probabile`);
   - `Incerta` altrimenti.
6. **Profilo debole:** `true` se il valore massimo di `S` è inferiore a 0,15 (`profilo_debole`).
7. **Affinità** (assegnazione morbida), con temperatura *T* = 0,10:

```
AFF[k] = exp((S[k] − max S) / T) / Σ_j exp((S[j] − max S) / T)
```

Le 7 affinità sommano a 1.

## 5. Validazione e segnalazioni

Le segnalazioni **non escludono** nessuno: il rispondente viene classificato e il caso va rivisto dall'analista, che decide se escluderlo.

| Situazione | Esito | Segnalazione |
|---|---|---|
| Domanda trappola presente e diversa da 1 | Classificato | `trap_fallita` |
| Q9 = 7 ("Never") | Classificato | `non_si_trucca` |
| Più di 3 risposte in una multipla | Classificato con tutte le risposte | `oltre_3_risposte_Q12` (o Q14…Q17) |
| Una multipla senza risposta | Classificato, blocco a 0 | `risposta_mancante_Q12` (o Q14…Q17) |
| Una tra Q9, Q10, Q11 senza risposta | Classificato con le altre due | `risposta_mancante_Q9` (o Q10, Q11) |
| Q9, Q10 e Q11 tutte senza risposta | **Non classificabile** | errore |
| Un item A1–A18 senza risposta | **Non classificabile** | errore |
| Codice non previsto o non numerico | **Non classificabile** | errore |

Le segnalazioni si elencano in quest'ordine: risposte mancanti di Q11, Q10 e Q9; poi, domanda per domanda da Q12 a Q17, risposta mancante o oltre 3 risposte; poi `trap_fallita`; infine `non_si_trucca`.

## 6. Output

| Campo | Contenuto |
|---|---|
| `versione` | Versione del classificatore, "1.1" |
| `cluster`, `cluster_nome` | Cluster assegnato: codice e nome |
| `cluster_2` | Secondo cluster più vicino |
| `margine` | Distacco tra primo e secondo cluster |
| `score_max` | Punteggio del cluster assegnato |
| `confidenza` | Netta, Probabile o Incerta |
| `profilo_debole` | true/false |
| `regola` | "punteggio massimo" o "spareggio (griglia attitudinale)" |
| `S_<cluster>` | Punteggio finale per ciascuno dei 7 cluster |
| `AFF_<cluster>` | Affinità per ciascuno dei 7 cluster, da 0 a 1 |
| `segnalazioni` | Elenco delle segnalazioni, separate da punto e virgola |
| `errore` | Motivo, solo se il rispondente non è classificabile |

La piattaforma dovrebbe salvare, per ogni rispondente, i codici delle risposte e l'output completo con la versione. Così le analisi per cluster restano ricostruibili anche dopo un cambio di versione.

## 7. Implementazione di riferimento

```
python classificatore_cluster_v1_1.py risposte_codificate.csv output.csv
python classificatore_cluster_v1_1.py --test casi_test_v1_1.csv
python classificatore_cluster_v1_1.py --da-forms export_forms.xlsx risposte_codificate.csv
```

La terza riga converte un export di Microsoft Forms, in inglese o in italiano, nel formato codificato e richiede pandas. Riconosce domande e opzioni dai testi del JSON e dagli `alias`, cioè le formulazioni usate nelle prime compilazioni del pilota.

La funzione `classifica(risposte, parametri)` restituisce un dizionario con i campi dell'output. È scritta senza librerie esterne proprio per essere tradotta riga per riga.

## 8. Verifica

`casi_test_v1_1.csv` contiene le colonne d'ingresso, una colonna `nota` e il risultato atteso nelle colonne `atteso_*`. L'implementazione della piattaforma è corretta se, per ogni caso:

- `cluster`, `cluster_2`, `confidenza`, `regola`, `profilo_debole` e `segnalazioni` coincidono esattamente;
- `margine`, i 7 punteggi `S` e le 7 affinità `AFF` differiscono di non più di 0,000001;
- i casi con `atteso_errore` non vuoto risultano non classificabili.

Casi inclusi:

- **R01–R64:** il pilota interno di ottobre 2026. Nell'analisi del pilota R02, R36 e R38 erano stati esclusi a mano; qui sono presenti, e R36 e R38 hanno la segnalazione `non_si_trucca`. R01 non ha risposto alla Q10.
- **T01–T14:** casi costruiti per coprire le regole della sezione 4 e 5, descritti nella colonna `nota`. T13 e T14 sono profili tipo di Essentials e Memories Recovers.

Prima di andare in produzione conviene ripetere la verifica sui codici salvati dalla piattaforma per qualche compilazione di prova.

## 9. Storia delle versioni

| Versione | Data | Modifiche |
|---|---|---|
| 1.0 | 8/10/2026 | Prima versione: profili costruiti dalle descrizioni dei cluster, lettura delle risposte dal testo inglese dell'export Forms |
| 1.1 | 3/11/2026 | Lettura per codice, quindi indipendente dalla lingua; parametri in JSON; segnalazioni per la revisione; gestione esplicita delle risposte mancanti. **Pesi e soglie invariati:** sui 64 rispondenti del pilota la v1.1 dà le stesse assegnazioni della v1.0, con scarti sotto 0,000001 |
