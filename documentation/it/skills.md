# Skill

Una skill è un manuale operativo scritto in Markdown che insegna a YOLO a fare un certo tipo di cosa a modo tuo.

La differenza rispetto alla [memoria](./memory.md): la memoria sono «fatti su di te», le skill sono «il metodo per fare un certo tipo di cosa».

## Che problema risolve

Immagina di dover ripetere ogni volta che riordini i verbali di una riunione: «dividi in tre parti — punti discussi, decisioni, azioni da fare; le azioni devono avere un responsabile e una scadenza». Una volta messo per iscritto come skill, ti basta dire «sistemami questo verbale» e il modello sa già come procedere.

Il valore di una skill non sta nel risparmiarti quelle due frasi, ma nel fatto che **il metodo resta fissato**, e non cambia da una volta all'altra.

## Caricamento progressivo

Una skill ha due livelli:

- **Frontmatter** (nome + descrizione) — sta sempre nel contesto
- **Corpo** — viene caricato solo quando serve

Il modello **decide se usare una skill basandosi unicamente sulla descrizione**. Vuol dire che la qualità della descrizione determina direttamente se la skill verrà attivata: conta più di quanto sia scritto bene il corpo.

Ogni skill può essere impostata su:

- **Su richiesta** (`lazy`, predefinito) — all'inizio viene fornita solo la descrizione, e il corpo si legge dopo l'attivazione
- **Iniezione completa** (`always`) — il corpo sta nel contesto a ogni turno

Con poche skill la differenza è minima; quando se ne accumulano parecchie, l'iniezione completa si mangia contesto in modo evidente. Lascia «su richiesta» come impostazione di base: l'iniezione completa se la meritano solo quelle regole che vanno rispettate sempre.

## Le skill integrate

YOLO ne porta con sé quattro:

| Skill | Caricamento | A cosa serve |
|------|---------|------|
| **obsidian-cli** | Su richiesta | Pilota la CLI ufficiale di Obsidian dal terminale, per gestire backlink, proprietà, note giornaliere e palette dei comandi: cose che i normali strumenti sui file non raggiungono |
| **obsidian-output-format** | Iniezione completa | Stabilisce le convenzioni di formato per produrre proposte di modifica in Markdown |
| **skill-creator** | Su richiesta | La «meta-skill» che insegna all'AI come si scrive una skill |
| **snippet-creator** | Su richiesta | Insegna all'AI come mantenere la tua libreria di snippet richiamabili con `/` |

Quando vuoi scriverne una tua, puoi semplicemente chiedere all'AI di usare **skill-creator**: conosce già i requisiti di formato.

## Scriverne una

Le skill stanno sotto `YOLO/skills/` nel vault (`YOLO` è il nome modificabile della cartella base, vedi **Impostazioni → YOLO → Altro → Manutenzione → Cartella base YOLO**), in due forme possibili:

- **File singolo**: `YOLO/skills/la-mia-skill.md`
- **Pacchetto in cartella**: `YOLO/skills/la-mia-skill/SKILL.md`, da usare quando servono script o materiali di riferimento a corredo

### Il formato

```markdown
---
name: meeting-notes
description: Trasforma i verbali grezzi di una riunione in un resoconto strutturato. Usala quando l'utente incolla il contenuto di una riunione, chiede di riassumerla o di estrarne le azioni da fare.
mode: lazy
---

# Redazione dei verbali di riunione

## Quando usarla
L'utente ha incollato un verbale o una trascrizione, oppure chiede di riassumere la riunione o di estrarre le azioni da fare.

## Passi
1. Individua i partecipanti, i temi e le conclusioni
2. Produci l'output in tre parti: «Punti discussi / Decisioni / Azioni da fare»
3. Ogni azione deve avere un responsabile e una scadenza; se non sono chiari, chiedilo all'utente
```

I tre campi del frontmatter:

- **`name`** — in kebab-case, univoco nel vault; è insieme identificatore e nome visualizzato
- **`description`** — **la riga più importante**. Deve dire sia «cosa fa» sia «quando usarla», perché il modello decide se attivarla basandosi solo su questa frase
- **`mode`** — `lazy` (predefinito) oppure `always`

### Come si scrive una descrizione efficace

Confronta i due casi:

- ❌ `description: strumento per i verbali di riunione` — il modello non sa in quali situazioni «tocca a lei»
- ✅ `description: Trasforma i verbali grezzi di una riunione in un resoconto strutturato. Usala quando l'utente incolla il contenuto di una riunione, chiede di riassumerla o di estrarne le azioni da fare.`

Una buona descrizione risponde insieme a «a cosa serve questa cosa» e «in quali condizioni devo ricordarmene». Dopo averla scritta, verificala così: se fossi il modello e vedessi solo questa frase, sapresti decidere se usarla?

### Cosa può usare una skill

Una skill può usare solo gli strumenti interni al vault (modifica dei file, terminale virtuale e simili): **non ha una propria capacità di accedere ad API esterne**. Se ti serve chiamare un servizio esterno, quello è il compito di [MCP](./mcp.md).

## Importare skill già pronte

**Impostazioni → YOLO → Agent → Competenze → «Importa Skill»**, con tre origini possibili:

- **Trascinare** file o cartelle nell'area apposita
- **Sfoglia File / Sfoglia Cartella**
- **Incollare un link GitHub**, in tre forme:
  - Un intero repository: `https://github.com/owner/repo`
  - Una sottocartella (come singolo pacchetto skill): `https://github.com/owner/repo/tree/main/path`
  - Un singolo file: `https://github.com/owner/repo/blob/main/path.md`

In caso di conflitto di nomi puoi scegliere tra «Sovrascrivi tutto» e «Salta conflitti».

> Una skill importata da internet è, a tutti gli effetti, un'istruzione che finirà nel tuo prompt di sistema. Prima di installarla dai un'occhiata al corpo e verifica che faccia quello che credi — soprattutto per quelle che contengono operazioni da terminale.

## Attivare e disattivare

Su due livelli:

- **Globale**: Impostazioni → YOLO → Agent → elenco delle competenze, con un interruttore per ciascuna. Disattivandola, nessun Agent può usarla
- **Per Agent**: nella scheda Competenze dell'Agent editor la attivi singolarmente, e lì puoi anche sovrascrivere la modalità di caricamento

Al primo utilizzo devi cliccare una volta su «**Inizializza sistema Skills**», che scrive i file modello dentro la tua cartella delle skill.

---

## Correlato

- Far ricordare all'Agent dei fatti invece che dei metodi: [Memoria](./memory.md)
- Collegarsi a servizi esterni: [MCP](./mcp.md)
- Assegnare skill diverse ad Agent diversi: [Agent e subagent](./assistants.md)
