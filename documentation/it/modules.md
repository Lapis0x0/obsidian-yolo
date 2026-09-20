# Moduli

I moduli sono pacchetti di funzionalità che si installano e si aggiornano in modo indipendente. Non vengono distribuiti insieme al plugin vero e proprio: li installi quando ti servono.

Dove si gestiscono: **Impostazioni → YOLO → Moduli**.

## Installazione e gestione

I moduli arrivano da un catalogo mantenuto ufficialmente, non da repository di terze parti a caso. Nella pagina delle impostazioni sono divisi in tre gruppi: «Attivi», «Disattivati» e «Disponibili».

Ogni scheda di modulo riporta icona, nome, numero di versione e descrizione, più i pulsanti d'azione che cambiano a seconda dello stato: Installa / Abilita / Aggiorna / Aggiorna e attiva / Disabilita / Disinstalla.

Quando c'è un aggiornamento, il numero di versione viene evidenziato nella forma `v1.2 → v1.3`.

**Quando un modulo non si può installare** il motivo viene scritto chiaramente: piattaforma non supportata, serve prima aggiornare YOLO Core, oppure schema dei dati incompatibile. In questi casi il pulsante di installazione non compare proprio.

Se il download o l'attivazione falliscono, viene indicato esattamente in quale passaggio (timeout / download non riuscito / controllo di integrità fallito / attivazione non riuscita), e puoi riprovare.

Una volta installato, se il modulo ha impostazioni proprie queste compaiono come voce a sé nella navigazione a sinistra della pagina Moduli.

> Dopo aver installato un modulo potresti accorgerti che nella chat compaiono strumenti nuovi, o che nel menu delle modalità ci sono voci in più: è normale, i moduli possono contribuire alla chat con strumenti e modalità propri.

---

# Modulo Apprendimento

Trasforma un argomento e una pila di materiali in contenuti di studio strutturati — schema, punti di conoscenza, carte, esercizi, mappa delle conoscenze — e ci abbina la ripetizione dilazionata per farteli ricordare davvero.

> Il modulo Apprendimento è attualmente in **beta pubblica**. Al primo accesso compare un avviso che devi confermare per proseguire.

## Aprirlo

L'icona del tocco accademico nella barra laterale sinistra, oppure il comando «Apri modalità apprendimento» dalla palette.

## Creare un progetto di apprendimento

Nel Centro apprendimento clicca su «Nuovo progetto»; i campi da compilare sono:

- **Argomento** — per esempio «React», «Parte generale del diritto penale»
- **Modalità di apprendimento** — al momento è disponibile la «Modalità standard» (genera un sistema strutturato con punti, carte ed esercizi); la «Modalità progetto» è contrassegnata come «In arrivo»
- **Livello attuale** — Principiante / Conosco i concetti / Ho esperienza / Avanzato
- **Obiettivo e note aggiuntive** — testo libero. Puoi scrivere tempi e casi d'uso, ma anche cosa non vuoi studiare
- **Materiali di riferimento** (facoltativi) — trascina e carica PDF, Word, Markdown; massimo 20 MB per file. Se carichi dei materiali, l'AI ci costruisce sopra uno schema su misura

### La generazione avviene per passi

Non viene generato tutto in una volta: a metà strada c'è un momento in cui confermi tu.

1. Clicca su «Crea e genera schema»: l'AI pianifica prima il percorso di apprendimento e la struttura dei capitoli
2. **Quando lo schema è pronto puoi modificarlo** — aggiungere e togliere capitoli, riordinarli trascinandoli, cambiare titoli e descrizione dell'ambito di ciascun capitolo
3. Quando sei soddisfatto clicca su «Conferma schema e genera punti»: i punti vengono generati capitolo per capitolo
4. Dopo di che si generano le carte

Il fatto che lo schema esca per primo, così che tu possa correggerlo, ha un senso preciso: se lo schema è sbagliato, tutto il resto sarà sbagliato, e correggere lo schema costa molto meno che correggere cento carte.

**La generazione può proseguire in background**: se passi a un'altra interfaccia continua, e a lavoro finito ricevi una notifica.

**Se si interrompe si può riprendere** — riaprendo il progetto vedi l'avviso «{completati}/{totale} capitoli generati» e, cliccando su «Continua da dove si è interrotta», la generazione riparte. Attenzione: è una capacità aggiunta in seguito, quindi i progetti creati prima che esistesse non possono essere ripresi automaticamente.

## Cosa c'è dentro un progetto

Aprendo un progetto trovi quattro schede:

| Scheda | Contenuto |
|------|------|
| **Schema** | La struttura ad albero di capitoli e punti di conoscenza. Puoi cercare, rigenerare un singolo punto, vedere per ogni punto quante carte ha e a che padronanza sei, e saltare alla nota corrispondente |
| **Mappa conoscenze** | Il grafo delle relazioni tra i punti di conoscenza |
| **Carte** | Le flashcard. Si girano con un clic o con la barra spaziatrice, e si valutano con «Dimenticato / Di nuovo / Incerto / Capito / Facile». Si possono filtrare per capitolo, e le carte si aggiungono, modificano, eliminano e sospendono a mano |
| **Esercizi** | Esercizi a domanda aperta. Scrivi la tua risposta e l'AI ti restituisce i punti corretti, quello che manca o è sbagliato, la spiegazione completa e una risposta di riferimento |

## Ripasso a ripetizione dilazionata

Carte ed esercizi sono entrambi pianificati con l'algoritmo FSRS.

Nella home del Centro apprendimento c'è «Inizia il ripasso di oggi», che ti porta direttamente su tutte le carte in scadenza oggi — **unendo i progetti tra loro**, così non devi entrare in ognuno separatamente. Anche la scheda Carte dentro un progetto permette di ripassare solo quel progetto.

Durante il ripasso la tua valutazione determina direttamente quando la carta ricomparirà, e l'interfaccia mostra l'intervallo successivo (in minuti, ore o giorni).

La padronanza ha tre livelli — Nuovo / In apprendimento / Padroneggiato — e la percentuale si vede sia nello schema sia nell'elenco delle carte.

La home riepiloga anche quante carte sono da ripassare oggi, cosa conviene ripassare per primo, la ritenzione stimata a 30 giorni e l'avanzamento di ciascun progetto.

## Importare da Anki

Da «Importa da Anki» nel Centro apprendimento, scegli un file `.apkg` (**massimo 200 MB**).

Il flusso prevede prima l'analisi e l'anteprima: vedi il numero di capitoli, di carte, quante carte hanno una cronologia di ripasso valida, quante sono sospese, quanti file multimediali ci sono, più avvisi ed elementi ignorati. Quando sei convinto inserisci il nome del progetto e clicchi su importa.

**La cronologia dei ripassi viene importata insieme**: non riparti da zero.

> **Per ora esiste solo l'importazione, non l'esportazione.** Non si possono riportare in Anki le carte del modulo Apprendimento.

---

# Modulo Lavagna

`.yoloboard` è il formato di canvas infinito proprietario di YOLO.

## Crearne una e importare

- **Nuova**: il comando «Nuova lavagna» dalla palette, oppure la voce di creazione nel menu dei file
- **Importare da Canvas**: clic destro su un file `.canvas` e scegli «Importa come lavagna YOLO»; per farlo in blocco usa il comando «Importa tutti i Canvas come lavagne YOLO»

L'importazione in blocco crea, accanto a ciascun Canvas, una lavagna con lo stesso nome nella stessa posizione. **I file Canvas originali non vengono modificati né eliminati.**

## Che rapporto ha con i Canvas di Obsidian

I due formati possono coesistere senza interferire. La differenza sostanziale sta nella natura delle schede.

**Una scheda su una lavagna YOLO è una finestra che inquadra una nota.** La scheda registra «quale punto di quella nota guardare, e come presentarlo»; il contenuto della nota resta il normale file Markdown di sempre. La lavagna memorizza solo posizione e dimensione della finestra.

I nodi dei Canvas di Obsidian assomigliano invece di più a un'istantanea con il contenuto incorporato.

Nella pratica la differenza è questa: se modifichi la nota, la scheda sulla lavagna cambia di conseguenza; e la posizione della scheda sulla lavagna non ha niente a che fare con la nota stessa.

## Le schede

Come si aggiungono (clic destro su un'area vuota o dalla barra strumenti):

- **Aggiungi nota** — scegli una nota già esistente nel vault
- **Aggiungi file multimediale** — immagini, audio, video presenti nel vault
- **Aggiungi pagina web** — inserisci un indirizzo http/https, oppure trascina direttamente un file HTML

Una scheda si può «Converti in nota»: se non è ancora collegata a una nota esistente, il contenuto viene scritto su disco come nota nuova.

Se il file citato viene eliminato o spostato, la scheda mostra il segnaposto «File mancante»; per i tipi di cui non è possibile l'anteprima compare «Non ancora visualizzabile».

## Le operazioni

Nel menu contestuale trovi:

- **Raggruppamento** — «Raggruppa la selezione» su più schede selezionate, oppure «Nuovo gruppo» vuoto; i gruppi si possono rinominare
- **Allineamento** — a sinistra / al centro orizzontale / a destra / in alto / al centro verticale / in basso
- **Distribuzione** — orizzontale ed equidistante, verticale ed equidistante
- **Riordina** — disposizione automatica con un clic
- **Inquadratura** — «Zoom sulla selezione», «Torna all'origine»
- **Collegamenti** — linee tra le schede, quattro stili di frecce, con etichetta di testo opzionale
- **Colore** — sei colori predefiniti, un colore personalizzato, e «Nessun colore» per togliere il colore già impostato

## Cosa può fare l'AI su una lavagna

Due strade.

**Gli strumenti lavagna nella chat** — il modulo contribuisce alla chat due strumenti: crea una lavagna, e modifica la lavagna aperta (aggiungere, togliere e spostare schede, creare collegamenti, raggruppare).

Questi strumenti sono a **divulgazione su richiesta**: se non hai mai creato una lavagna, non ti occupano contesto.

Lo strumento di modifica **agisce solo su schede e collegamenti, non sul testo dentro le schede**. La lettura di una lavagna passa dal normale strumento di lettura dei file, e restituisce un riepilogo invece di centinaia di KB di dati grezzi.

Inoltre, YOLO stesso **si rifiuta** di modificare un file `.yoloboard` con i normali strumenti di modifica testuale: serve a evitare che dati strutturati vengano rovinati trattandoli come testo semplice.

**I pulsanti AI in linea sulle schede** — quattro azioni rapide che agiscono su una singola scheda: **Approfondisci / Idee / Metti in dubbio / Riassumi**. Al clic l'AI legge quella scheda e quelle adiacenti come contesto, genera il contenuto e lo riscrive nella scheda. Si può fermare in qualsiasi momento.

---

## Correlato

- Come si gestiscono gli strumenti contribuiti dai moduli: [Strumenti e permessi](./tools-and-permissions.md)
- Le note a cui puntano le schede della lavagna: [Chat](./chat.md)
