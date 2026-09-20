# Riferimento delle impostazioni

Una consultazione rapida, nell'ordine in cui compaiono nell'interfaccia, di cosa fa ciascuna impostazione. Se invece vuoi capire come si usa una funzione, segui il link alla pagina che la tratta.

La pagina delle impostazioni ha sei schede: **Modelli / Agent / Sparkle / Conoscenza / Moduli / Altro**.

---

## Modelli

Vedi [Modelli e provider](./models.md).

### Provider

L'elenco delle schede dei provider, riordinabile trascinando; cliccando sull'intestazione si espande per vedere i modelli sottostanti.

I campi della **finestra di modifica del provider**:

| Campo | Descrizione |
|------|------|
| ID provider | Serve solo a distinguerlo in locale, non è un campo lato API |
| Chiave API | Alcuni provider locali non la richiedono, si può lasciare vuota |
| URL base | Endpoint di terze parti o auto-ospitato; c'è un'«Anteprima:» per vedere l'indirizzo completo composto |
| Nessun header stainless | Risolve gli errori CORS causati da `x-stainless-*` |
| Usa requestUrl di Obsidian | Aggira il CORS, al prezzo di perdere la risposta in streaming |
| Metodo richiesta di rete | Auto / Richiesta browser / Richiesta integrata Obsidian / Connessione diretta desktop |
| Modalita streaming risposta | Auto / Streaming / Non streaming |
| Cache del prompt | Solo famiglia Anthropic, attiva di default. Le scritture in cache hanno un sovrapprezzo, le letture che la colpiscono costano molto meno |
| Header personalizzati | Coppie chiave-valore, su più righe |

> Eliminare un provider **elimina a cascata** tutti i suoi modelli chat e di embedding, e svuota i dati vettoriali relativi.

I **modelli chat** si modificano riga per riga, e nell'intestazione c'è il «Test di connettività». Un modello attualmente impostato come modello chat predefinito o come modello per il titolo delle conversazioni non si può eliminare né disabilitare.

I campi della **modifica di un modello**: ID modello, Nome modello, Tipo di ragionamento, Modalità di input, Strumenti integrati del provider, Token finestra di contesto, Token massimi in output, parametri di richiesta, Parametri personalizzati.

### Criteri modello predefiniti e prompt

| Impostazione | Predefinito | Descrizione |
|------|------|------|
| Modello chat predefinito | — | Quello usato da tutte le interfacce di chat |
| Modello per titolo conversazione | — | Genera automaticamente il titolo; ci sta bene un modello piccolo ed economico |
| Abilita recupero automatico | Attivo | Quando la richiesta in streaming fallisce, ritenta una volta in modalità non streaming |
| Timeout richiesta primaria | 60 secondi | I modelli con ragionamento pesante ci sbattono facilmente, si può alzare |
| Prompt di sistema globale | Vuoto | Aggiunto all'inizio di ogni conversazione. **Supporta `![[Nota]]` per incorporare il testo completo di una nota** |
| Prompt titolo chat | Vuoto | Lasciandolo vuoto si usa quello predefinito incorporato |

---

## Agent

Vedi [Strumenti e permessi](./tools-and-permissions.md) e [Agent e subagent](./assistants.md).

### Capacità globali

Due schede: **Strumenti** e **Competenze**, ciascuna con un pulsante per gestirle.

La finestra «Gestisci strumenti» elenca tutte le capacità integrate in tre categorie: **Vault / Contesto e memoria / Esterno**. Gli interruttori qui sono una saracinesca globale: se li chiudi, nessun Agent può usare quella capacità.

Alcune capacità hanno un pulsante a ingranaggio che porta alle loro impostazioni dedicate: ricerca web (i provider di ricerca), sandbox di analisi (i sottopermessi), comandi del terminale (la lista dei prefissi bloccati), delega a subagent (il pool di modelli).

In fondo alla finestra c'è la **gestione dei server MCP**, che su **mobile è nascosta per intero**.

La finestra «Gestisci competenze»: inizializza il sistema Skills, aggiorna, importa skill (trascinandole o da link GitHub), elimina in blocco, e attiva o disattiva le singole skill.

### Agent

Una griglia di schede Agent, riordinabile trascinando. Il **Default** integrato non si può eliminare.

L'Agent editor ha quattro schede:

**Profilo** — Nome, Descrizione, Icona, Modello (con l'opzione «Segui modello predefinito»), System prompt, più tre interruttori:

| Interruttore | Predefinito | Descrizione |
|------|------|------|
| Sincronizzazione del focus | Attivo | Percepisce quale nota / pagina PDF / punto della pagina web stai guardando |
| Consapevolezza dell'ora corrente | Attivo | Comunica al modello l'ora di invio del messaggio |
| Carica file di istruzioni del progetto | Disattivo | Carica automaticamente `AGENTS.md` e `CLAUDE.md` dalla radice del vault |

**Strumenti** — Abilita strumenti, Includi strumenti integrati, più lo stato di attivazione e il livello di approvazione capacità per capacità. I server MCP hanno in più la modalità di divulgazione (Su richiesta / In contesto) e la modalità di approvazione. In alto c'è una stima dei token.

**Competenze** — attivazione e modalità di caricamento (Iniezione completa / Su richiesta) skill per skill.

**Spazio di lavoro** — l'interruttore «Limita l'ambito di lavoro autonomo» più l'editor dell'ambito. **Occhio alla riga di avviso in fondo: con il terminale o con MCP di terze parti abilitati, questo ambito può essere aggirato e non costituisce un confine di sicurezza.**

### Capacità Agent

Quattro schede richiudibili, tutte impostazioni globali.

**Lettura immagini**

| Impostazione | Predefinito | Descrizione |
|------|------|------|
| Lettura immagini | Attiva | Disattivandola le tre voci sottostanti si nascondono |
| Scarica URL immagini esterne | **Disattiva** | Scarica anche i link a image host / CDN presenti nel Markdown. Timeout di 5 secondi per immagine, e sopra i 10 MB si salta. È disattiva di default perché invia richieste a terze parti |
| Compressione immagini | Attiva | |
| Qualità di compressione | 85 | **Controlla insieme dimensioni e qualità**: 60 significa ridurre al 60% con qualità 60%, non sono due parametri indipendenti |

**Compattazione contesto**

| Impostazione | Predefinito | Descrizione |
|------|------|------|
| Compattazione automatica del contesto | **Disattiva** | |
| Modalita soglia | — | Token di prompt assoluti / Quota della finestra di contesto |
| Soglia token di prompt | 100000 | Quando scegli la modalità assoluta |
| Uso finestra di contesto (%) | 80% | Quando scegli la modalità a quota; richiede che il modello abbia il valore della finestra di contesto compilato |

> Quando scatta, **ricorda all'Agent di compattare**: non è un troncamento forzato imposto dal plugin.

**Accesso per agenti esterni** — permette a client MCP esterni di usare a loro volta il tuo vault. **Solo desktop**, porta predefinita 28124. Vedi [MCP](./mcp.md#esporre-yolo-agli-agent-esterni).

> Il token viene generato solo alla prima attivazione, e non esiste un pulsante dedicato per rigenerarlo. Se devi cambiarlo, disattiva e riattiva l'interruttore.

**Runtime CLI** — **solo desktop**. Indica il percorso dell'eseguibile per ciascuna delle sei CLI; lasciandolo vuoto si usa il rilevamento automatico. Salvato solo su questo dispositivo, non sincronizzato con il vault. Vedi [CLI Agent](./cli-agent.md).

### Notifiche

> Nell'interfaccia questo blocco si trova **in fondo alla scheda Agent**.

| Impostazione | Predefinito |
|------|------|
| Abilita notifiche | **Disattive** |
| Metodo di notifica | Solo suono |
| Quando notificare | Solo quando non è in focus |
| Notifica quando serve l'approvazione | Attiva |
| Notifica al termine del task | Attiva |

---

## Sparkle

Vedi [Sparkle](./sparkle.md).

### Snippet

Stanno in `YOLO/snippets.md` e si richiamano scrivendo `/` nella casella di input della chat. Al primo utilizzo clicca su «Inizializza snippet» per creare il file modello.

### Quick Ask

| Impostazione | Predefinito |
|------|------|
| Abilita Quick Ask | Attivo |
| Dock automatico in alto a destra | Attivo |
| Carattere di attivazione | `@` (da 1 a 3 caratteri) |
| Contesto prima del cursore (caratteri) | 5000 |
| Contesto dopo il cursore (caratteri) | 2000 |

C'è anche l'accesso alla configurazione dei «Preset di continuazione scrittura», che gestisce le azioni rapide della modalità di continuazione (etichetta, prompt, categoria, icona; si riordinano trascinandole). Le azioni rapide si possono solo eliminare: non esiste un interruttore per «nascondere ma conservare».

### Cursor chat

La barra di strumenti che compare quando selezioni del testo. Le azioni rapide sono personalizzabili, e ciascuna ha una modalità di esecuzione: Quick Ask ask / Quick Ask rewrite / Aggiungi alla casella chat / Aggiungi alla casella chat e invia.

**Ogni azione personalizzata viene registrata automaticamente come comando di Obsidian** (con il prefisso `[Cursor Chat]`), quindi può avere una sua scorciatoia da tastiera.

### Completamento Tab

| Impostazione | Predefinito | Descrizione |
|------|------|------|
| Completamento tab | **Disattivo** | È la causa più comune del «Sparkle non fa niente» |
| Modello completamento tab | Segue il modello di continuazione | Ci sta bene un modello piccolo e veloce |
| Timeout richiesta | — | 1–120 secondi |
| Vincoli completamento tab | Vuoto | Requisiti aggiuntivi, per esempio «scrivi in italiano» |
| Tabella dei trigger | 6 regole integrate | Virgole e due punti cinesi e occidentali, a capo, elementi di elenco |
| Ritardo trigger | 3000 ms | Minimo 200 ms |
| Completamento automatico dopo pausa | **Disattivo** | |
| Ritardo completamento automatico | 3000 ms | |
| Cooldown completamento automatico | 15000 ms | |

> Regolazioni più fini, come la lunghezza del completamento, stanno nel **pannello Sparkle dentro l'editor**, non in questa pagina delle impostazioni.

---

## Conoscenza

Vedi [Knowledge base e ricerca](./knowledge-base.md).

La **barra di stato in cima** cambia con lo stato: quando l'indicizzazione è spenta mostra il pulsante «Attiva e indicizza»; a regime mostra il numero di documenti indicizzati, quanti attendono aggiornamento, l'interruttore di aggiornamento automatico, il pulsante «Aggiorna ora» e un menu «…» (Ricostruisci tutti gli indici / Gestisci dati indicizzati / Disattiva indicizzazione).

Ogni **scheda di knowledge base** ha tre cose da configurare: nome, descrizione (fornita al modello per scegliere quale base consultare) e ambito. L'ambito è un campo solo: nel selettore delle cartelle contrassegni ciascuna cartella come «Includi» o «Escludi».

Il **modello di embedding** è diviso in due parti: modello API e scaffale locale.

> Dopo aver selezionato un modello API **devi cliccare anche su «Imposta come corrente» perché abbia effetto**. Il passaggio in più c'è perché cambiare modello di embedding equivale a ricostruire l'intero indice.

L'embedding locale è **solo desktop**, e supporta la scelta tra CPU e GPU.

**Impostazioni avanzate** (globali, non per singola knowledge base):

| Impostazione | Predefinito | Descrizione |
|------|------|------|
| Indicizza file PDF | Attivo | Disattivandolo si velocizza un vault grande |
| Dimensione chunk | 1000 | **Dopo la modifica serve ricostruire l'indice a mano perché abbia effetto** |
| Similarità minima | 0.0 | |
| Limite | 10 | Quanti risultati restituisce ogni ricerca |
| Concorrenza embedding | 10 | 1–24. **Se vedi errori 429 di limite di frequenza, abbassala** |

---

## Moduli

La navigazione a sinistra ha «Gestisci moduli» e «Componenti runtime», e più sotto le impostazioni proprie di ciascun modulo attivo.

I **componenti runtime** sono quattro: Tokenizer, Motore PDF, Motore Bash, Motore di embedding (solo desktop).

> L'interruttore di un componente runtime governa **se il componente esiste**; l'interruttore in «Gestisci strumenti» governa **se lo strumento è visibile all'AI**. I nomi si somigliano, ma non sono la stessa cosa.

Vedi [Moduli](./modules.md) e [Strumenti e permessi](./tools-and-permissions.md#componenti-runtime).

---

## Altro

### Supporta il progetto

Star, Afdian, Buy Me a Coffee, più i link per segnalare un bug e richiedere una funzione (che portano con sé automaticamente numero di versione e informazioni di sistema).

### Interazione

| Impostazione | Predefinito | Descrizione |
|------|------|------|
| Icona ribbon apre la chat in | Barra laterale destra | Alternative: Nuova scheda / Split destro / Nuova finestra (solo desktop) / Ultima posizione usata |
| Usa Invio per andare a capo | Disattivo | Di base Invio invia. Attivandolo si passa a Cmd/Ctrl+Invio per inviare |
| Posizione visualizzazione mention | Dentro la casella | Oppure Badge in alto |
| Modalita contesto file @ | **Modalita leggera** | La modalità leggera inietta solo percorsi, proprietà e struttura, incoraggiando l'AI a leggere solo il necessario. **Questa voce incide direttamente sul consumo di token** |
| Chat apply behavior (comportamento di applicazione nella chat) | Review before apply | Passando a «Write directly to file», il clic su Applica non chiede più una seconda conferma: è un'impostazione a rischio |
| Mantieni evidenziazione blocco selezione | Attiva | |
| Scala interfaccia chat | 100% | 70%–150% |

> «Chat apply behavior» non è ancora tradotta in italiano e appare in inglese.

### Esportazione chat

| Impostazione | Predefinito |
|------|------|
| Esporta processo di ragionamento | Disattivo |
| Esporta chiamate strumento | Disattivo |

### Manutenzione

| Impostazione | Predefinito | Descrizione |
|------|------|------|
| Notifiche di aggiornamento | Attive | Disattivandole non vieni più avvisato delle nuove versioni, né del plugin né dei moduli |
| Scarica aggiornamenti automaticamente | Attivo | Vale solo su desktop e con la cartella del plugin scrivibile |
| Export settings / Import settings (esporta e importa le impostazioni) | — | Per migrare da un vault all'altro |
| **Cartella base YOLO** | `YOLO` | Percorso relativo al vault. Cambiarla è **un'operazione di spostamento**, vedi sotto |
| Abilita debug richieste LLM | Disattivo | Attivandolo, ogni messaggio guadagna un pulsante Debug per consultare richieste e risposte grezze |

> «Export settings» e «Import settings» non sono ancora tradotte in italiano e appaiono in inglese.

Sulla **Cartella base YOLO** fai attenzione: non può iniziare con `/` e non può essere una cartella nascosta (i nomi che iniziano con `.` vengono rifiutati). Cambiandola, il plugin prova a spostare il contenuto della vecchia cartella nel nuovo percorso; **se la destinazione esiste già e non è vuota, l'operazione viene rifiutata e l'impostazione precedente viene mantenuta**. È un'operazione ad alto rischio: fai un backup prima di toccarla.

Il contenuto del **debug delle richieste LLM** resta in memoria solo per la sessione corrente, e si azzera al riavvio di Obsidian. All'esportazione le chiavi API vengono oscurate, **ma il testo originale della conversazione è incluso**: controlla tu prima di condividerlo.

### Operazioni pericolose

Richiedono tutte una seconda conferma:

| Operazione | Effetto |
|------|------|
| Cancella cronologia chat | Elimina tutte le sessioni e i messaggi |
| Cancella snapshot e cache chat | Elimina snapshot del contesto, snapshot delle modifiche e cache delle altezze della timeline, **senza toccare i messaggi**. Dopo, la prima apertura di una vecchia conversazione sarà più lenta: non è perdita di dati |
| Ripristina provider | Torna alla configurazione predefinita, **sovrascrivendo invece di unire** |
| Ripristina agent | Elimina tutti gli Agent personalizzati, lasciando solo Default |
| Ripristina impostazioni | Riporta tutte le impostazioni ai valori di fabbrica; è l'ultima voce dell'intera pagina |
