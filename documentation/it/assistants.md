# Agent e subagent

Un Agent è un pacchetto di configurazione riutilizzabile: la personalità, il modello, quali strumenti può usare, quali skill può leggere, in quali cartelle può muoversi. Una volta configurato lo attivi nella chat con un clic.

> **Sui nomi**: nella pagina delle impostazioni questa cosa si chiama «**Agent**», e il pulsante per crearne uno è «Nuovo agent»; nell'interfaccia di chat, invece, il menu a tendina per cambiarlo dice «**Assistente**». I due termini indicano la stessa cosa; in questa pagina useremo sempre Agent.

Dove si configura: **Impostazioni → YOLO → Agent → Agent**.

## Ce n'è già uno di default

C'è un Agent integrato chiamato **Default**, che **non può essere eliminato**. Se non configuri niente, è quello che stai usando.

## Creare un nuovo Agent

Clicca su «Nuovo agent» per entrare nell'editor: a sinistra ci sono quattro schede, **Profilo / Strumenti / Competenze / Spazio di lavoro**.

### Profilo

- **Nome**, **Descrizione**, **Icona**
- **Modello** — puoi indicare un modello preciso, oppure scegliere «Segui modello predefinito»
- **System prompt** — la personalità e il modo di lavorare di questo Agent. In alto a destra c'è un pulsante «Espandi editor» per scrivere a schermo intero (si chiude con Esc)

Nel prompt di sistema è supportato `![[Nota]]` per **incorporare il testo completo di una nota**. Scrivere in una nota le convenzioni lunghe, i glossari o il contesto di un progetto e poi citarla è molto più facile da mantenere che infilare un muro di testo nella casella.

Sotto ci sono altri tre interruttori:

| Interruttore | Predefinito | A cosa serve |
|------|------|------|
| **Sincronizzazione del focus** | Attivo | Fa percepire all'AI quale nota stai guardando, a che pagina del PDF sei, in che punto della pagina web ti trovi |
| **Consapevolezza dell'ora corrente** | Attivo | Comunica al modello l'ora in cui hai inviato il messaggio |
| **Carica file di istruzioni del progetto** | Disattivo | Carica automaticamente `AGENTS.md` e `CLAUDE.md` dalla radice del vault come istruzioni di progetto |

«Carica file di istruzioni del progetto» serve alla compatibilità con le convenzioni di strumenti come Codex, Claude Code e Cursor. Se il tuo vault è anche un repository di codice, o se hai già scritto un `AGENTS.md`, attivandolo lo riutilizzi.

> Nell'editor **non** ci sono parametri di campionamento come temperatura o Top P. Quelli si configurano sul modello stesso ([Modelli e provider](./models.md#parametri-del-modello)), non a livello di Agent.

### Strumenti

Prima di tutto due interruttori generali: **Abilita strumenti** e **Includi strumenti integrati**.

Sotto, tutte le capacità elencate per categoria; ognuna si attiva singolarmente e si imposta il suo livello di approvazione (Accesso completo / Richiedi approvazione / Approva solo operazioni pericolose). Anche i server MCP già connessi compaiono qui, espandibili per vedere ogni singolo strumento che offrono.

In cima al pannello vedi il numero di strumenti attivi e una **stima dei token** approssimativa: le definizioni degli strumenti occupano contesto, e più ne attivi più consumi a ogni turno, quindi quel numero ti aiuta a scegliere.

I server MCP hanno due menu a tendina aggiuntivi:

- **Modalità di divulgazione** — «Su richiesta» mette nel prompt di sistema solo i nomi degli strumenti, e la definizione completa viene caricata quando il modello ne ha bisogno; «In contesto» porta la definizione completa a ogni turno. Per i server con molti strumenti, «Su richiesta» fa risparmiare parecchi token
- **Approvazione** — gli stessi livelli visti sopra

> Le capacità disattivate globalmente in «Gestisci strumenti» qui non compaiono nemmeno. Il livello globale è una saracinesca a monte, vedi [Strumenti e permessi](./tools-and-permissions.md).

### Competenze

Elenca tutte le skill; ciascuna può essere attivata solo per questo Agent, con la possibilità di sovrascriverne la modalità di caricamento:

- **Iniezione completa** — il corpo della skill entra nel contesto a ogni turno
- **Su richiesta** — restano solo nome e descrizione, e il corpo viene caricato quando il modello ritiene che serva

Anche qui in cima c'è una stima dei token, più il conteggio di quante skill sono a iniezione completa e quante su richiesta. Le skill già disattivate globalmente non compaiono.

Come si scrivono le skill è spiegato in [Skill](./skills.md).

### Spazio di lavoro

Attivando «Limita l'ambito di lavoro autonomo» puoi indicare le cartelle in cui questo Agent può navigare e scrivere in autonomia.

Ci sono tre regole da capire per forza (**soprattutto la terza**):

1. I file che citi con `@` e il file che hai aperto **non sono mai limitati**: l'ambito limita la capacità dell'AI di andare a cercare da sola, non le cose che le passi tu
2. La cartella della memoria e quelle delle skill autorizzate sono **sempre esenti**
3. **Questo non è un confine di sicurezza**: se l'Agent ha i comandi del terminale o strumenti MCP di terze parti, l'ambito può essere aggirato

La spiegazione completa del punto 3 è in [Strumenti e permessi](./tools-and-permissions.md#ambito-dello-spazio-di-lavoro-limitare-dove-esplora-da-solo). In breve: se vuoi isolamento vero, ottienilo non dandogli il terminale e gli MCP di cui non ti fidi, non con questa impostazione dell'ambito.

## Cambiare Agent nella chat

Sopra la casella di input c'è il selettore dell'Agent; in alternativa scrivi `@` e scegli la categoria «Assistente». Scegliere «Nessun assistente» significa non legarsi a nessun Agent e conversare direttamente con il prompt di sistema globale.

Il pannello Quick Ask può avere un Agent tutto suo, diverso da quello della chat principale: per esempio la chat principale può usare un Agent di ricerca rigoroso, e Quick Ask un assistente di scrittura più leggero.

## Come conviene dividere gli Agent

Il valore di un Agent sta nel **confezionare insieme personalità e permessi**, non nel cambiare semplicemente il prompt. Alcuni criteri di divisione che funzionano davvero:

- **Per livello di fiducia**: un Agent «domande» in sola lettura (senza capacità di modifica) e un Agent «riordino» che mette mano ai file (con modifica e terminale). Passi al secondo solo quando serve, e il resto del tempo non hai da preoccuparti di errori
- **Per progetto**: un Agent per progetto, con l'ambito dello spazio di lavoro bloccato sulla cartella del progetto e il prompt di sistema che incorpora la nota di contesto di quel progetto
- **Per lingua o stile**: un assistente di scrittura con sempre le stesse regole stilistiche

---

# Subagent

Un subagent è un assistente temporaneo che l'Agent principale **manda in campo da solo** mentre lavora, per gestire un sotto-compito che si può portare a termine in autonomia.

## Non lo attivi tu a mano

Non puoi «avviare un subagent» direttamente. Quello che puoi fare è dare la capacità all'Agent principale, e poi è lui a decidere quando usarla.

I passi per configurarla:

1. Nella scheda **Strumenti** dell'Agent editor attiva «**Delega a subagent**» (disattivata per impostazione predefinita)
2. Nelle impostazioni della capacità configura il **pool di modelli delegabili**: scegli alcuni modelli già configurati e aggiungili al pool, indicando il modello preferito. Quando l'Agent principale non specifica un modello, viene usato quello preferito

## Che rapporto ha con la conversazione principale

Capire questi punti evita di farsi male:

**Il subagent non vede la cronologia della conversazione principale.** È una sessione temporanea isolata, quindi l'Agent principale deve scrivere tutte le informazioni necessarie nell'istruzione di delega. Se ti accorgi che un subagent risponde a sproposito, di solito è perché l'Agent principale non gli ha spiegato bene il contesto.

**È asincrono.** La delega restituisce subito un ID attività, il subagent gira in background e, quando ha finito, riporta il risultato all'Agent principale. **Il risultato non diventa automaticamente una risposta per te**: è l'Agent principale a decidere come usarlo e se dirtelo.

**Eredita il modello e gli strumenti autorizzati dell'Agent principale**, con due esclusioni: non può delegare a sua volta ad altri subagent (per evitare regressioni infinite), e non può usare strumenti che richiedono un'interazione con te (per esempio «Chiedi all'utente»).

**Le sue chiamate agli strumenti richiedono comunque approvazione**, con lo stesso percorso degli strumenti normali, solo aggregate in una scheda «In attesa di approvazione · N» dove puoi approvare tutto o rifiutare tutto in blocco.

Quando nella conversazione compare la scheda di un subagent, puoi espanderla per vedere il registro delle sue attività, quante chiamate a strumenti ha fatto e quanti token ha consumato.

## Quando conviene attivarla

I subagent vanno bene per lavori «che si sanno descrivere in modo autonomo e che finiscono con una conclusione», tipo «riassumi in tre frasi ciascuna di queste venti note». L'Agent principale li manda in campo e nel frattempo continua a fare altro, senza doversi tirare dentro il testo integrale di venti note — **ed è il loro valore più grande: isolare il consumo di contesto**.

Al contrario, i compiti che richiedono continue conferme da parte tua, o che dipendono strettamente dalla cronologia della conversazione corrente, affidati a un subagent peggiorano soltanto.

---

## Correlato

- Capacità strumentali e approvazioni: [Strumenti e permessi](./tools-and-permissions.md)
- Skill: [Skill](./skills.md)
- Far ricordare all'Agent le cose tra una conversazione e l'altra: [Memoria](./memory.md)
