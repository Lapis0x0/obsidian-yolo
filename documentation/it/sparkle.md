# Sparkle

Sparkle è l'insieme delle funzioni AI che **non ti fanno uscire dall'editor**: completamento al cursore, riscrittura del paragrafo selezionato, un pannello fluttuante per fare domande al volo.

Segue un percorso completamente diverso da quello della [Chat](./chat.md): generazione a turno singolo, bassa latenza, nessuna chiamata a strumenti e nessuna approvazione. Il che significa che è veloce, ma anche che non legge le tue altre note e non modifica altri file.

Dove si configura: **Impostazioni → YOLO → Sparkle**.

## Il pannello Quick Ask

Per chiedere una cosa al volo o correggere un pezzo di testo nell'editor, con il risultato che finisce direttamente al cursore.

### Come si richiama

Due modi:

- **Scrivere `@` all'inizio di una riga vuota** — il carattere di attivazione si può cambiare nelle impostazioni (da 1 a 3 caratteri). Dopo averlo scritto il carattere viene cancellato automaticamente e il pannello compare vicino al cursore
- **Palette dei comandi → «Attiva quick ask»**

Per impostazione predefinita, dopo che hai inviato la domanda il pannello **si aggancia automaticamente in alto a destra nell'editor**, così non copre il testo; una volta che lo trascini a mano, smette di seguirti.

### Le tre modalità

Nel pannello si cambia con Tab: non sono tre ingressi separati.

| Modalità | Cosa fa |
|------|--------|
| **Ask** | Domande e risposte, permessi di sola lettura, identica alla modalità Ask della chat laterale |
| **Agent** | Esegue l'Agent dentro lo stesso pannello: può leggere e scrivere note ed eseguire attività in più passi |
| **Scrivi** (continuazione) | Non passa dall'Agent né dalla catena di strumenti: continua a scrivere direttamente al cursore |

**Nella modalità di continuazione puoi inviare senza scrivere niente**: prosegue seguendo il contesto corrente. Oppure puoi dare un'indicazione precisa per orientarla, tipo «continua con tre controesempi».

### Cosa fare del risultato

Nel pannello hai queste azioni: **Copia**, **Inserisci** (al cursore), **Apri nella barra laterale** (sposta questa conversazione nella chat laterale per proseguire, utile quando parlando ti accorgi che serve approfondire), Ferma e Cancella conversazione.

### L'ampiezza del contesto

Quick Ask porta con sé il testo prima e dopo il cursore: di base 5000 caratteri prima e 2000 dopo, entrambi regolabili nelle impostazioni.

### I preset di continuazione

La modalità di continuazione può avere delle azioni rapide preconfigurate, così non devi riscrivere le istruzioni ogni volta. Nelle impostazioni clicca su «Configura azioni rapide»: ogni azione ha etichetta, prompt, categoria (Suggerimenti / Scrittura / Pensiero / Personalizzato) e icona, e si riordinano trascinandole.

Ci sono nove preset integrati; se fai confusione puoi usare «Ripristina predefiniti».

> Le azioni rapide si possono solo eliminare: non esiste un interruttore per «nascondere ma conservare».

## Completamento tab

Mentre scrivi propone al cursore un suggerimento in grigio, che accetti con Tab.

> **Il completamento tab è disattivato per impostazione predefinita.** È la ragione più comune del «ma perché Sparkle non fa niente?». Vai nelle impostazioni e attivalo.

### Quando si attiva

Due meccanismi di attivazione, che possono convivere:

**Attivazione per pattern** (predefinita) — il suggerimento compare quando il testo prima del cursore corrisponde a una regola. Ce ne sono sei integrate: virgola cinese e occidentale, due punti cinesi e occidentali, a capo, inizio di un elemento di elenco (`- ` `* ` `+ `). Nella tabella dei trigger puoi attivarle e disattivarle una per una, aggiungerne, rimuoverne, o trasformarle in espressioni regolari.

**Completamento automatico dopo pausa** (disattivato per impostazione predefinita) — si attiva da solo dopo che hai smesso di scrivere per un po', di base 3 secondi. Ha un cooldown di 15 secondi per non interromperti di continuo.

Puoi anche richiamarlo a mano una volta dalla palette dei comandi, con «Attiva completamento tab».

### Accettare e rifiutare

| Tasto | Effetto |
|------|------|
| `Tab` | Accetta il suggerimento |
| `↑` / `↓` | Passa da un candidato all'altro |
| `Maiusc+Tab` / `Esc` / `Backspace` | Rifiuta e cancella il suggerimento |

Nella palette dei comandi c'è anche «Accetta completamento», comodo se vuoi associarlo a un altro tasto o farlo richiamare da plugin come Commander.

### I parametri regolabili

- **Modello completamento tab** — può essere diverso dal modello della chat. Qui sta bene un modello piccolo e veloce: la latenza conta più dell'intelligenza
- **Timeout richiesta** — da 1 a 120 secondi
- **Vincoli completamento tab** — una richiesta aggiuntiva, per esempio «scrivi in italiano» o «non completare i blocchi di codice»
- **Ritardo trigger** — minimo 200 millisecondi

> Nella pagina delle impostazioni ci sono solo questi parametri di base. Regolazioni più fini, come la lunghezza del completamento, stanno nel pannello Sparkle dentro l'editor, non nelle impostazioni del plugin.

## Riscrittura della selezione

Selezionando del testo compare una barra di strumenti (non è il menu contestuale di sistema) con queste azioni:

| Azione | Descrizione |
|------|------|
| **Aggiungi alla chat** | Mette la selezione come riferimento nella casella di input della chat corrente |
| **Aggiungi alla barra laterale** | La invia alla chat laterale, aprendola automaticamente se è chiusa |
| **Riscrittura personalizzata** | Scrivi un'istruzione di riscrittura, applicata solo a questa selezione |
| **Domanda personalizzata** | Fai una domanda su questo contenuto |
| **Spiega in dettaglio** / **Fornisci suggerimenti** / **Traduci in cinese** | Azioni predefinite integrate |
| **Regola lunghezza** | Trascina la maniglia per sintetizzare o espandere (le selezioni di tabella non sono ancora supportate) |

Nella casella della riscrittura personalizzata, **Maiusc+Invio conferma**, Invio va a capo, Esc chiude.

La riscrittura **tocca solo il contenuto della selezione**: non agisce sull'intero documento né su altri file come farebbe l'Agent. Se mentre aspetti il risultato modifichi il testo originale e la selezione decade, ti verrà chiesto di selezionare di nuovo.

### Azioni rapide personalizzate

Nella sezione «Cursor chat» delle impostazioni puoi aggiungere e rimuovere queste azioni rapide. Ognuna si configura con: etichetta, testo dell'istruzione, modalità di esecuzione e assistente associato.

Le modalità di esecuzione sono quattro:

- **Quick Ask ask** — invia automaticamente
- **Quick Ask rewrite** — entra in anteprima; qui puoi scegliere ancora tra «Prompt personalizzato (chiedi ogni volta)» e «Prompt predefinito (esegui subito)»
- **Aggiungi alla casella chat** — la inserisce soltanto, senza inviare
- **Aggiungi alla casella chat e invia**

Ogni azione personalizzata **viene registrata automaticamente come comando di Obsidian** (con il prefisso `[Cursor Chat]`), così puoi assegnarle una scorciatoia da tastiera dedicata.

## Similar notes

Nella scheda Sparkle della barra laterale c'è un pannello «Similar notes» (note simili) che fa ricerca vettoriale a partire dalla nota che hai aperto ed elenca le altre note collegate; puoi espanderle per vedere i passaggi corrispondenti, oppure inserire un collegamento al cursore.

Dipende dalla [knowledge base](./knowledge-base.md): serve un modello di embedding configurato, e la nota corrente dev'essere già stata indicizzata. Se manca qualcosa, il pannello ti mostra il pulsante che porta dove serve.

> Questa parte dell'interfaccia non è ancora tradotta in italiano e appare in inglese.

## L'Esc globale

Premere **Esc** in qualsiasi momento annulla tutte le attività di continuazione e riscrittura AI in corso. Vale ovunque, e non interferisce con gli altri comportamenti normali di Esc (come chiudere una finestra di dialogo).

---

## Correlato

- Per attività in più passi e su più file: [Chat](./chat.md)
- Come si configurano il modello di completamento e quello di continuazione: [Modelli e provider](./models.md#a-cosa-serve-ciascun-modello-predefinito)
- L'indice da cui dipendono le note simili: [Knowledge base e ricerca](./knowledge-base.md)
