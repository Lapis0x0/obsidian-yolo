# Strumenti e permessi

Questa pagina risponde a una domanda sola: **cosa può fare davvero YOLO alle mie cose, e come lo tengo a bada.**

Se ti basta una rassicurazione rapida, ricorda tre cose:

1. **La modalità stabilisce il tetto dei permessi.** Ask non può modificare il testo delle tue note, Agent può modificare i file nel vault, Max può toccare qualsiasi file della macchina.
2. **Per impostazione predefinita, modificare file ed eseguire comandi di terminale richiedono il tuo consenso.** Puoi passare all'approvazione automatica, ma è una scelta che fai tu, attivamente.
3. **L'ambito dello spazio di lavoro non è una sandbox.** Limita il comportamento autonomo dell'AI, non è isolamento di sicurezza: la differenza è spiegata in dettaglio più avanti.

## Come sono organizzati gli strumenti

YOLO raggruppa le sue capacità in 13 «capacità strumentali»: quello che attivi, disattivi e per cui configuri l'approvazione è la capacità, non il singolo strumento.

Dove si gestisce: **Impostazioni → YOLO → Agent → Capacità globali → Strumenti → «Gestisci strumenti»**.

Gli interruttori qui sono una **saracinesca globale**: se chiudi qui, nessun Agent può usare quella capacità. Ogni Agent può poi restringere ulteriormente nella propria configurazione — i due livelli sono in AND: se è aperto globalmente ma chiuso su quel singolo Agent, quell'Agent comunque non può usarlo.

### L'elenco completo delle capacità

| Capacità | Cosa fa | In quali modalità | Predefinito | Approvazione predefinita |
|------|--------|-------------|------|---------|
| **Leggi** | Legge file del vault, skill, pagine web aperte | Ask / Agent | Attivo | Accesso completo |
| **Terminale virtuale** | Shell in sandbox limitata al vault, ricerca con `ls`/`grep`/`find`, più `mkdir`/`mv`/`rm` | Ask / Agent | Attivo | Approva solo operazioni pericolose |
| **Set modifica file** | Modifica puntuale o riscrittura completa delle note | Solo Agent | Attivo | Richiedi approvazione |
| **Ricerca nel vault** | Ricerca semantica combinata con parole chiave | Tutte | Attivo | Accesso completo |
| **Set strumenti ricerca web** | Ricerca sul web, estrazione del testo delle pagine | Tutte | Attivo | Accesso completo |
| **Chiedi all'utente** | Si ferma e ti interroga quando mancano informazioni | Tutte | Attivo | Accesso completo |
| **Lista delle attività** | Scompone e traccia da solo le attività in più passi | Agent / Max | Attivo | Accesso completo |
| **Pota risultati strumenti** | Toglie i vecchi risultati degli strumenti dal contesto successivo | Tutte | Disattivo | Accesso completo |
| **Compatta contesto** | Comprime la conversazione precedente in un riassunto | Tutte | Disattivo | Accesso completo |
| **Sandbox di analisi** | Esegue JavaScript in un ambiente isolato per calcoli e statistiche | Solo Agent | Disattivo | Accesso completo |
| **Comandi del terminale** | Il terminale **vero** della macchina | Agent / Max | Disattivo | Richiedi approvazione |
| **Delega a subagent** | Manda in campo un agent temporaneo e isolato per un sotto-compito | Tutte | Disattivo | Accesso completo |
| **Set strumenti filesystem locale** | Legge e scrive file in **qualsiasi percorso della macchina** | **Solo Max** | Attivo | Accesso completo |

### Qualche punto che si presta a fraintendimenti

**Il «Terminale virtuale» non è un vero terminale.** È una shell in sandbox reimplementata in JavaScript, montata sulla radice del tuo vault, che non tocca il filesystem del sistema operativo. L'unica capacità che esegue davvero comandi sulla macchina è «Comandi del terminale», che è disattivata di default, funziona solo su desktop, richiede approvazione di default, e **non può essere impostata su «consenti sempre»**.

**Modalità Ask non vuol dire sola lettura.** Il terminale virtuale in Ask è attivo, quindi in Ask si possono eseguire `mkdir`, `mv`, `rm`: non cambia le parole dentro le tue note, ma può spostare ed eliminare file. Per queste operazioni pericolose ti viene chiesto ogni volta.

**La ricerca web è ad accesso completo per impostazione predefinita.** Vuol dire che nella configurazione di partenza l'AI cerca sul web ed estrae pagine senza chiederti niente. Se la cosa non ti va bene, alza il livello di approvazione in «Gestisci strumenti» o disattivala del tutto.

**Il «Set strumenti filesystem locale» esiste solo in modalità Max.** La modalità Agent non ci arriva mai. È una scelta deliberata: Agent passa dall'interfaccia vault di Obsidian, Max è l'identità che opera davvero sul disco della macchina, e le due si escludono a vicenda.

**I sottopermessi della sandbox di analisi vanno attivati uno per uno.** Anche dopo aver attivato la sandbox di analisi, le voci «Allow Network Fetch», «Allow Vault Read», «Allow Open Web Page Read», «Allow Knowledge Base Query» e «Allow External Scripts» restano interruttori indipendenti, ciascuno con la sua conferma di rischio alla prima attivazione. Tra questi, «Allow External Scripts» è segnalato come **rischio estremo**: permette di scaricare ed eseguire JavaScript remoto arbitrario con gli stessi privilegi di una scheda del browser.

> Questa sezione delle impostazioni non è ancora tradotta in italiano e appare in inglese.

## Approvazione: come lo governi quando vuole agire

### I tre livelli di approvazione

Ogni capacità può essere impostata su:

- **Accesso completo** — non chiede, esegue e basta
- **Richiedi approvazione** — si ferma a ogni chiamata e aspetta la tua conferma
- **Approva solo operazioni pericolose** — ce l'ha solo il terminale virtuale: i comandi di sola lettura e `mkdir` passano direttamente, mentre `mv` e `rm` si fermano e chiedono uno per uno

Il livello si imposta per singolo Agent nella scheda **Agent editor → Strumenti**. Anche gli strumenti MCP esterni si configurano lì, per server.

### Le tue opzioni quando compare la richiesta di approvazione

- **Consenti** — lascia passare solo questa volta
- **Consenti per questa chat** — non chiede più in questa conversazione
- **Rifiuta** — puoi allegare un motivo del rifiuto, che il modello riceve e su cui si regola
- **Interrompi** — annulla l'intera attività

Il terminale virtuale e i comandi del terminale **non offrono** «Consenti per questa chat», perché sono stati progettati deliberatamente in modo da non poter aggirare la conferma volta per volta.

### L'approvazione automatica (interruttore YOLO)

Le modalità Agent e Max hanno ciascuna un interruttore «YOLO»: attivandolo, in quella modalità **nessuna chiamata a strumenti viene più sottoposta una per una**.

Alla prima attivazione compare un avviso di rischio, da confermare spuntando «Ho compreso i rischi sopra indicati». Le tre cose che dice sono tutte vere:

- Gli strumenti vengono eseguiti senza approvazione per chiamata, ma **i prefissi di comandi pericolosi restano bloccati**
- L'esecuzione autonoma può consumare parecchi token
- Fai un backup in anticipo

**La lista di prefissi bloccati vale in ogni circostanza**, approvazione automatica inclusa. Di default blocca i comandi che iniziano con: `rm`, `dd`, `mkfs`, `fdisk`, `shutdown`, `reboot`, `poweroff`, `halt`. Puoi aggiungerne e toglierne da «Configura comando terminale».

## Ambito dello spazio di lavoro: limitare dove esplora da solo

Dove si configura: scheda **Agent editor → Spazio di lavoro**, attivando «Limita l'ambito di lavoro autonomo» e poi usando il selettore visuale delle cartelle per marcare inclusioni ed esclusioni.

### Tre regole da conoscere per forza

**Primo, quello che gli dai tu non è soggetto a limiti.** I file che citi con `@` e il file che stai modificando in quel momento l'AI può sempre leggerli, anche se sono fuori ambito. Questa scelta è giusta: l'ambito limita la capacità dell'AI di **andare a cercare da sola**, non le cose che **gli passi tu**.

**Secondo, le cartelle della memoria e delle skill sono sempre esenti.** Anche se non le metti nell'ambito incluso, l'AI può comunque leggere e scrivere la propria memoria e le skill autorizzate.

**Terzo, ed è il più importante: questo non è un confine di sicurezza.**

> Se l'Agent ha abilitati i **comandi del terminale** o **strumenti MCP di terze parti**, l'ambito dello spazio di lavoro può essere aggirato.

Il motivo non è difficile: i comandi del terminale eseguono una shell reale, e gli strumenti MCP girano in processi esterni; né gli uni né gli altri passano dal controllo dei percorsi di YOLO. Quindi l'ambito dello spazio di lavoro va inteso come **un vincolo di autonomia — «tieniti sulle cartelle giuste, non andare a curiosare ovunque»** — e non come **un meccanismo di isolamento — «chiudi l'AI in gabbia»**.

Se ti serve davvero isolamento, la cosa giusta da fare è non dare a quell'Agent né il terminale né strumenti MCP di cui non ti fidi: non affidarti all'impostazione dell'ambito.

Va detto anche che la cartella dei dati interni di YOLO (`data`, dentro la cartella base) resta nascosta all'AI qualunque ambito tu imposti: un accesso restituisce «il file non esiste» invece di «permesso negato», così nemmeno la sua esistenza viene rivelata.

## Componenti runtime

Alcune capacità dipendono da componenti runtime scaricati a parte, che si gestiscono in **Impostazioni → YOLO → Moduli → Componenti runtime**:

| Componente | Cosa sostiene | Cosa succede se lo disattivi | Peso |
|------|---------|-----------|------|
| **Tokenizer** | Conta i token del contesto | Il budget preciso dei token non è più disponibile | circa 1 MB |
| **Motore PDF** | Estrae testo dai PDF e ne renderizza le pagine | Non si possono più leggere i PDF | circa 2,3 MB |
| **Motore Bash** | Il terminale virtuale | Lo strumento terminale virtuale diventa del tutto indisponibile | circa 1,3 MB |
| **Motore di embedding** | Esegue i modelli di embedding locali (solo desktop) | L'embedding locale non è disponibile e la ricerca torna al servizio di embedding remoto | circa 0,5 MB il componente + circa 27 MB di risorse runtime |

Questi componenti vengono scaricati in una cartella del plugin stesso, **non dentro il vault e non sincronizzati**: nell'elenco dei file di Obsidian non li vedi.

> Attenzione a distinguere due livelli. L'interruttore di un componente runtime governa **se quel componente esiste**; l'interruttore in «Gestisci strumenti» governa **se lo strumento è visibile all'AI**. I nomi si somigliano ma non sono la stessa cosa: se disattivi il Motore Bash, il terminale virtuale perde le sue fondamenta; se invece disattivi il terminale virtuale in Gestisci strumenti, il motore resta lì, è solo l'AI che non può usarlo.

Nell'interfaccia esistono solo «Abilita / Disabilita», e la disabilitazione non cancella automaticamente i file già scaricati. Per recuperare davvero lo spazio devi ripulire a mano la cartella `runtime/` dentro la cartella del plugin.

## Come dovrei configurarlo

Le configurazioni corrispondenti ad alcune posizioni tipiche:

**«Voglio solo fare domande, in sicurezza»** — basta la modalità Ask, non serve toccare nessuna impostazione.

**«Voglio che mi modifichi le note, ma voglio vedere ogni passo»** — modalità Agent, approvazione automatica disattivata, «Richiedi approvazione» mantenuta sulla modifica dei file.

**«Mi fido, lascio che vada fino in fondo da solo»** — Agent più approvazione automatica. Prima però assicurati che il vault sia sotto Git, o come minimo che il ripristino dei file di Obsidian sia attivo.

**«Non voglio che tocchi certe cartelle»** — configura l'ambito dello spazio di lavoro, e contemporaneamente **non** dare a quell'Agent i comandi del terminale, altrimenti l'ambito è carta straccia.

**«Non voglio proprio che vada in rete»** — vai in «Gestisci strumenti» e disattiva il set strumenti ricerca web. Nota che questo non influisce sulle chiamate alle API dei modelli.

---

## Correlato

- La spiegazione completa delle modalità: [Chat](./chat.md#ask-agent-e-max)
- Configurare ruoli con permessi diversi a seconda dell'uso: [Agent](./assistants.md)
- I rischi del collegamento a strumenti esterni: [MCP](./mcp.md)
