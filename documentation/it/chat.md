# Chat

La chat è l'interfaccia principale di YOLO. È qui che fai domande, gli fai leggere e scrivere note, gli affidi attività in più passi. Questa pagina copre tutto quello che l'interfaccia di chat sa fare.

Se non hai ancora configurato un modello, comincia dalla [Guida rapida](./getting-started.md).

## Aprire la chat

YOLO ha una sola vista di chat, ma può aprirla in quattro posizioni: **barra laterale**, **nuova scheda**, **divisione destra**, **finestra separata**. Le quattro posizioni sono funzionalmente identiche, cambia solo il modo in cui occupano lo schermo: la barra laterale è comoda per chiedere mentre scrivi, la finestra separata serve quando lasci l'Agent su un compito lungo e vuoi continuare a lavorare nella finestra principale.

Ci sono tre modi per aprirla:

- **Icona nella barra laterale sinistra**: un clic sull'icona YOLO apre la chat nella posizione predefinita. **Un clic destro sull'icona** permette di scegliere la posizione solo per quella volta, senza cambiare l'impostazione predefinita.
- **Palette dei comandi**: cerca «Apri chat», «Apri nuova chat (nuova scheda)», «Apri nuova chat (divisione destra)», «Apri nuova chat (nuova finestra)».
- **Menu dentro l'interfaccia di chat**: una volta aperta una chat, dal suo menu puoi spostarla in un'altra posizione.

> **YOLO non assegna nessuna scorciatoia da tastiera.** Su un'installazione nuova tutti questi comandi sono senza associazione. Se vuoi richiamare la chat da tastiera, vai in «Impostazioni → Scorciatoie da tastiera» di Obsidian, cerca il nome del comando e assegnala tu. Lo stesso vale per tutti i comandi citati più avanti.

## Passargli le note: i riferimenti

Per impostazione predefinita la chat non sa quale nota stai guardando. Perché ne legga il contenuto devi citarla esplicitamente.

### Il menu `@`

Scrivi `@` nella casella di input e si apre il menu dei riferimenti, con cinque categorie:

| Categoria | A cosa serve |
|------|------|
| **File** | Cita una nota. In cima al menu compare di solito direttamente «File corrente», la voce più usata di tutte |
| **Cartella** | Cita un'intera cartella |
| **Modalita** | Passa direttamente da Ask ad Agent o Max |
| **Assistente** | Cambia l'Agent in uso |
| **Modello** | Cambia il modello per questo turno |

Se continui a scrivere dopo la `@`, la ricerca fuzzy si applica a tutte le categorie insieme: non serve scegliere prima la categoria.

Modalità, Agent e modello sono stati messi dentro il menu `@` proprio perché tu possa cambiarli al volo mentre scrivi, senza spostare la mano su un menu a tendina da un'altra parte.

### Pagine web, immagini e file

Queste tre cose **non passano dal menu `@`**: hanno ciascuna il proprio ingresso.

- **Pagine web**: incolla l'indirizzo direttamente nella casella di input e diventa automaticamente un riferimento web. Non serve altro.
- **Immagini**: usa il pulsante «+» della casella di input, oppure incolla direttamente un'immagine dagli appunti, oppure trascina il file immagine nell'area di input.
  Serve che **il modello in uso supporti l'input di immagini**. Se il modello non ha la capacità visiva attiva, al caricamento ti verrà chiesto di attivare prima la modalità di input «Immagini» nelle impostazioni del modello.
- **Allegati**: sempre dal pulsante «+»; sono supportati PDF, Word / PPT / Excel, e i formati di testo semplice come txt, md, csv, json, yaml, xml, log.
  I PDF hanno un trattamento speciale: con i modelli che leggono i PDF nativamente (Anthropic, Gemini) YOLO passa il file originale al modello; in parallelo estrae comunque il testo come ripiego, così il documento resta leggibile anche se cambi modello.

Ci sono poi due ingressi minori ma comodi: su un PDF puoi usare «Cattura regione PDF nella chat» per selezionare un'area e mandarla come immagine; e nell'elenco dei file, con il **clic destro** su una nota o una cartella, trovi «Aggiungi file alla chat» e «Aggiungi cartella alla chat».

## Ask, Agent e Max

La modalità decide **cosa è permesso fare** a YOLO. È il concetto più importante dell'intero plugin: sbagliare modalità porta a pensare «ma perché non riesce a fare niente?» oppure «ma come si permette di toccarmi i file?».

La modalità si cambia dal menu a tendina accanto alla casella di input, oppure con `@` → Modalita.

### Ask — per domande, rifinitura e riscrittura

Prevalentemente in sola lettura. Può leggere le note, interrogare la knowledge base, cercare sul web, trovare file nel vault, ma **non può modificare il testo delle note**.

C'è però un aspetto controintuitivo che vale la pena chiarire subito: in modalità Ask, YOLO può comunque eseguire **operazioni di organizzazione dei file** come `mkdir`, `mv`, `rm` (creare cartelle, spostare, eliminare file). Ask quindi non significa «sola lettura assoluta»: non cambia le parole dentro le tue note, ma può spostare i file stessi.

Queste operazioni avvengono **solo dentro il tuo vault**: passano dal terminale virtuale, una sandbox montata sulla radice del vault che non arriva agli altri file del sistema operativo. E comunque queste operazioni pericolose **richiedono la tua approvazione ogni singola volta**, e non è consentito impostarle su «consenti sempre».

### Agent — abilita la catena di strumenti per attività in più passi

Rispetto ad Ask aggiunge quattro capacità:

- **Modificare il testo delle note** (modifica puntuale o riscrittura completa)
- **Lista delle attività**: davanti a un compito in più passi si fa un piano da solo e lo porta avanti punto per punto
- **Sandbox di analisi**: esegue JavaScript in un ambiente isolato per fare calcoli e statistiche in blocco
- **Comandi del terminale**: un vero terminale locale (solo desktop, con approvazione richiesta per impostazione predefinita)

È il livello che usi tutti i giorni quando vuoi che l'AI ti riordini le note, converta formati in blocco o scriva note nuove a partire da del materiale.

### Max — opera direttamente su file locali e terminale (solo desktop)

Max supera i confini del vault: può leggere e scrivere **file in qualsiasi percorso della macchina**, non limitati al vault e non limitati al Markdown. Anche le capacità di terminale sono più complete, ed è l'unica modalità in cui il terminale può essere impostato su «consenti sempre».

Va bene per lavori che escono dai confini di Obsidian, tipo «prendi quella pila di PDF sulla scrivania e sistemala nel vault». **Il prezzo è che quello che può toccare va ben oltre il tuo vault**: assicurati di averlo capito prima di usarla.

> Se stai usando un CLI Agent esterno (Claude Code e simili), vedrai anche una modalità **Plan**: prima esplora e propone un piano, e passa all'azione solo dopo la tua conferma. Vedi [CLI Agent](./cli-agent.md).
> Dopo aver installato dei moduli, anche i moduli possono registrare modalità proprie, come quella dedicata al modulo Lavagna.

### L'approvazione automatica «YOLO»

Sotto Agent e Max c'è per ciascuna un sotto-interruttore: attivandolo, **le chiamate agli strumenti non ti vengono più sottoposte una per una**. Non è una quarta modalità, ma un livello che si sovrappone a queste due.

Alla prima attivazione compare un avviso di rischio, e devi spuntare «Ho compreso i rischi sopra indicati»:

- Gli strumenti vengono eseguiti senza approvazione per chiamata (i prefissi di comandi pericolosi restano comunque bloccati)
- Può consumare parecchi token
- Fai un backup in anticipo

Max più approvazione automatica è la combinazione con più permessi in assoluto: qualsiasi percorso della macchina, più tutti i comandi di terminale in scrittura esenti da approvazione. Consigliata solo quando hai perfettamente chiari i confini del compito.

## Cambiare modello e Agent

Il **modello** si cambia in qualsiasi momento dal menu a tendina sopra la casella di input: vale solo per i messaggi successivi e non altera quelli già generati.

L'**Agent** è un ruolo confezionato che mette insieme «prompt di sistema + preferenze sugli strumenti + skill», ed è indipendente sia dal modello sia dalla modalità. Puoi per esempio avere un Agent «scrittura accademica» con un suo insieme di prompt fisso, e abbinarlo a qualunque modello e a qualunque modalità. Vedi [Agent e subagent](./assistants.md).

> Nella pagina delle impostazioni questo concetto si chiama «Agent», mentre il menu a tendina nell'interfaccia di chat lo chiama «Assistente»: sono la stessa cosa con due nomi diversi.

## Inviare messaggi

Di base **Invio invia, Maiusc+Invio va a capo**.

Se scrivi spesso messaggi su più righe, puoi attivare nelle impostazioni «Usa Invio per andare a capo»: il comportamento si inverte, quindi **Invio va a capo e Cmd/Ctrl+Invio invia**.

Su mobile Invio va sempre a capo, così non parte niente per sbaglio.

**Mentre l'Agent sta lavorando puoi comunque continuare a scrivere e inviare**: il messaggio si mette in coda e parte alla fine del turno in corso. Ci sono però due situazioni che lo bloccano: se uno strumento sta aspettando la tua approvazione devi prima approvarlo o rifiutarlo; e se il modello ti sta facendo una domanda devi prima rispondere. Se interrompi la conversazione, i messaggi ancora in coda e non inviati tornano nella casella di input: non si perdono.

## Durante la conversazione

### L'approvazione degli strumenti

Quando l'approvazione automatica è disattivata, ogni chiamata a uno strumento fa comparire nella conversazione una scheda con queste scelte:

- **Consenti** — lascia passare questa volta
- **Rifiuta** — non esegue; il modello riceve il rifiuto e prosegue
- **Consenti sempre questo strumento** — d'ora in poi non chiede più per questo strumento
- **Consenti per questa chat** — non chiede più, ma solo all'interno di questa conversazione
- **Interrompi** — annulla l'intero turno

Le operazioni pericolose come eliminazione e spostamento fanno comparire una conferma aggiuntiva, con l'elenco dei percorsi esatti da eliminare o spostare. La delega a un subagent ha un suo gruppo di pulsanti di approvazione (Approva / Rifiuta / Approva tutto / Rifiuta tutto / Vedi parametri).

Anche il modello può fare domande a te: in quel caso il titolo è «L'agente ti pone delle domande», al massimo tre per volta, a scelta singola, a scelta multipla o a risposta libera. Si invia con Cmd/Ctrl+Invio, e puoi anche annullare le domande di quel turno.

### Come le modifiche alle note arrivano su disco

Il modello non sovrascrive le note direttamente. Prima produce un diff, e solo quando clicchi su **Applica** il contenuto finisce nel file (durante l'applicazione puoi comunque interromperla).

C'è poi un'interfaccia più granulare, «Rivedi modifiche», dove decidi punto per punto: accetta questa modifica / rifiuta questa modifica / mantieni / ripristina / accetta entrambe, spostandoti tra le modifiche con «Modifica precedente» e «Modifica successiva», oppure accettando o rifiutando tutto in blocco.

Sotto ogni risposta compare un **riepilogo delle modifiche**, che indica quanti file sono stati toccati in quel turno e quali sono stati creati o eliminati; da lì puoi annullare tutto il turno, oppure annullare solo un singolo file.

> **L'annullamento dipende da snapshot locali, e gli snapshot non vengono sincronizzati insieme alle note.** Vuol dire che da un altro dispositivo non puoi annullare le modifiche fatte qui; e se nel frattempo il file è stato modificato, o lo snapshot è andato perso, l'annullamento fallisce e te lo dice. Per le modifiche che contano davvero, affidati a Git o al ripristino dei file di Obsidian.

### Fermare, rigenerare, correggere la domanda, creare un ramo

- **Ferma generazione**: il pulsante accanto alla casella di input. In più, **Esc funziona ovunque**: premendolo annulli tutte le attività di continuazione e riscrittura AI in corso.
- **Rigenera**: sotto ogni risposta.
- **Modificare un messaggio già inviato**: clicca su un tuo messaggio per modificarlo; dopo averlo reinviato, la conversazione successiva viene rieseguita sul nuovo contenuto.
- **Create branch from here** (creare un ramo da qui): su una risposta puoi creare una sessione derivata che conserva il contesto fino a quel punto e prosegue in un'altra direzione. È comodo per confrontare due linee di ragionamento, e la conversazione originale resta intatta.

## Gestire le conversazioni

### Cronologia

L'icona dell'orologio in alto apre l'elenco della cronologia; c'è anche il comando «Apri cronologia chat» (disponibile solo quando sei già nella vista di chat).

Nell'elenco puoi cercare, fissare, rinominare, archiviare, eliminare (due clic per confermare), e filtrare per categoria: «Le mie conversazioni» e «Conversazioni di attività» sono separate, e le conversazioni di attività si possono filtrare per origine, incluse quelle avviate da un agent esterno.

### Esportazione

L'icona di download in alto, oppure il comando «Esporta la conversazione attuale nel vault», salva l'intera conversazione come nota Markdown nel vault. Si possono esportare solo le sessioni già salvate.

### Quanto contesto stai usando

Vicino alla casella di input c'è l'indicatore di utilizzo del contesto; aprendolo vedi la scomposizione voce per voce: quanti token occupano il prompt di sistema, gli strumenti, le regole, le skill, la memoria, la conversazione e il ragionamento, più la percentuale di cache colpita nel turno precedente.

Due cose da sapere: è una **stima locale**, e può differire da quello che il server fattura davvero; e la percentuale compare solo se hai configurato il limite della finestra di contesto sul modello, altrimenti ti verrà suggerito di completare quel campo nelle impostazioni del modello.

### Compattare il contesto

Quando la conversazione diventa troppo lunga, scrivi `/` nella casella di input e scegli **Compatta contesto**: la cronologia più vecchia viene compressa in un riassunto, e l'attività corrente prosegue in una nuova finestra di contesto. Se il contesto proprio non ci sta più, YOLO compatta anche da solo.

Dopo la compattazione nella conversazione compare una linea di separazione che segnala che il contenuto sopra è stato compresso in un riassunto e che le risposte successive partono da quel riassunto, con la stima dei token del contesto risultante.

Per compattare serve che non ci sia nessuna risposta in generazione e nessuno strumento in attesa di approvazione, altrimenti ti verrà chiesto di sistemare prima quelle.

---

## Prosegui

- Usare l'AI senza uscire dall'editor: [Sparkle](./sparkle.md)
- Far rispondere il modello sulla base dell'intero vault: [Knowledge base e ricerca](./knowledge-base.md)
- Capire esattamente cosa può fare ai tuoi file: [Strumenti e permessi](./tools-and-permissions.md)
