# Memoria

La memoria permette a YOLO di ricordare le tue preferenze, le tue abitudini e il contesto di lungo periodo da una conversazione all'altra, senza che tu debba rispiegare tutto a ogni nuova chat.

## La memoria è fatta di note normali

È il punto più importante per capire il sistema della memoria: **YOLO non ha uno «strumento di memoria» dedicato; la memoria sono normali file Markdown nel tuo vault.**

L'AI li mantiene usando le sue capacità generiche di lettura e scrittura dei file. Il che significa che in qualsiasi momento puoi aprirli, leggerli, modificarli a mano o cancellarli: non sono una scatola nera sepolta in un database.

## Dove stanno i file

Di base sotto `YOLO/memory/` nel vault, su due livelli:

```
YOLO/memory/global/MEMORY.md        ← indice, valido per tutti gli Agent
YOLO/memory/global/<un ricordo>.md   ← un singolo fatto concreto

YOLO/memory/<nome Agent>/MEMORY.md   ← indice, valido solo per quell'Agent
YOLO/memory/<nome Agent>/<un ricordo>.md
```

> **Il nome della cartella radice `YOLO` si può cambiare.** Si modifica in **Impostazioni → YOLO → Altro → Manutenzione → Cartella base YOLO**, e le cartelle di skill, memoria e simili si spostano di conseguenza. Per comodità di lettura, qui sotto scriviamo sempre `YOLO/`: sostituiscilo con quello che hai impostato tu.

Ogni cartella contiene un indice `MEMORY.md` più un certo numero di file di fatti indipendenti, **un fatto per file**.

### Come si dividono il lavoro i due livelli

- **Memoria globale** (`global/`): fatti veri per tutti gli Agent. Chi sei, le tue preferenze di lungo periodo, gli strumenti che usi abitualmente
- **Memoria dell'Agent** (`<nome Agent>/`): fatti che hanno senso solo per un Agent specifico. Per esempio «nel rapporto settimanale raggruppa per reparto» serve solo a quell'Agent lì

Il nome della cartella di un Agent deriva dal suo nome visualizzato, e in caso di omonimia viene aggiunto un numero progressivo. Se il tuo Agent si chiama proprio `global`, viene messo in `global (assistant)/` per non entrare in collisione con la memoria globale.

## Il rapporto tra indice e contenuto

`MEMORY.md` è l'indice: ogni riga contiene un collegamento a un file di memoria specifico più una frase di riepilogo.

**L'indice entra per intero nel prompt di sistema, il contenuto no.** L'AI guarda prima l'indice per capire quali voci potrebbero essere pertinenti, e va a leggere il contenuto di una voce solo quando serve. Il disegno serve a risparmiare contesto: puoi accumulare molti ricordi, ma ogni turno paghi solo l'indice.

Ecco perché quella frase di riepilogo nell'indice conta così tanto: decide se l'AI si ricorderà di quel ricordo al momento giusto.

## Come fa l'AI a scriversi i ricordi

Nel prompt di sistema viene sempre iniettato un insieme di regole sulla memoria, che chiedono al modello di:

- Tenere un fatto per file, con nel frontmatter un `name` (in kebab-case, uguale al nome del file) e una `description` (una frase)
- **Scrivere il perché**, non solo la conclusione: così il ricordo resta applicabile anche in un altro contesto
- Prima di aggiungerne uno nuovo, controllare nell'indice se esiste già qualcosa sullo stesso tema, e in tal caso aggiornarlo invece di crearne un altro
- Cancellare i ricordi obsoleti o sbagliati, eliminando insieme la riga dell'indice
- Scrivere date assolute, mai «la settimana scorsa» o «tre giorni fa»
- Non ricopiare nella memoria contenuti che stanno già in una nota del vault, ma puntare a quella nota
- A ogni aggiunta, modifica o eliminazione, **aggiornare l'indice nello stesso turno**

Puoi dirgli esplicitamente «ricordati questa cosa», oppure lasciare che decida da solo.

## Quando i ricordi non vengono scritti

**In modalità Ask non si può scrivere.** La memoria si appoggia alla capacità di modifica dei file, che è disponibile solo in modalità Agent. Ask può leggere la memoria, non scriverla.

Le regole sulla memoria vengono iniettate comunque, senza condizioni (anche quando non hai ancora nemmeno un ricordo): servono a far sapere al modello che il meccanismo esiste. Ma in una modalità senza permessi di scrittura la parte «scrivi» di quelle regole semplicemente non si applica.

## Come la gestisci tu

Apri i file in Obsidian e modificali: sono note normali.

Dopo che hai modificato a mano `MEMORY.md`, l'istantanea in cache del prompt di sistema viene invalidata e il turno successivo la rilegge: in pratica la modifica ha effetto immediato, senza bisogno di riavviare.

> Quando è l'AI a scrivere un ricordo, l'invalidazione non scatta (altrimenti bisognerebbe ricostruire la cache a ogni singola scrittura): per questo **un ricordo appena scritto dal modello di solito diventa pienamente operativo dalla sessione successiva**.

## Memoria e ambito dello spazio di lavoro

La cartella della memoria è **sempre esente** dal limite dell'ambito dello spazio di lavoro. Anche se chiudi un Agent dentro una sottocartella specifica, quell'Agent può comunque leggere e scrivere la propria memoria e quella globale.

Ma **la cartella di memoria di un altro Agent non è esente**: l'esenzione non permette a un Agent di leggere la memoria privata di un altro.

## Quanto pesa nel contesto

Nel pannello di utilizzo del contesto della chat, la memoria ha una sua voce dedicata, così vedi subito quanti token si sta mangiando. Se i ricordi si accumulano, ricordati di tornare a fare pulizia: l'indice lo paghi a ogni turno.

---

## Correlato

- Come si legge l'utilizzo del contesto: [Chat](./chat.md#quanto-contesto-stai-usando)
- Come si configura un Agent: [Agent e subagent](./assistants.md)
- La differenza tra memoria e skill: [Skill](./skills.md) — la memoria sono «fatti su di te», le skill sono «il metodo per fare un certo tipo di cosa»
