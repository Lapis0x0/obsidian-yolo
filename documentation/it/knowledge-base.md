# Knowledge base e ricerca

Solo dopo aver indicizzato il vault YOLO può davvero dire di «aver letto» le tue note: non perché gliele indichi ogni volta con `@`, ma perché sa trovare da solo i contenuti pertinenti per significato.

Dove si configura: **Impostazioni → YOLO → Conoscenza**.

## Cosa succede se non indicizzi

Funziona lo stesso. L'AI ha uno strumento «Ricerca nel vault» che, in assenza di indice, **degrada automaticamente a pura ricerca per parole chiave**: trova le note che corrispondono letteralmente, ma non quelle che «dicono la stessa cosa con altre parole».

Nell'interfaccia compare l'avviso: «L'indicizzazione della knowledge base è disattivata · Lo strumento Ricerca dell'Agent userà solo la ricerca per parole chiave».

Una volta indicizzato, lo stesso strumento diventa **ricerca vettoriale combinata con parole chiave**. Non devi attivare nessuna «modalità RAG»: l'AI se ne serve da sola.

## Avviare l'indicizzazione

Serve prima un **modello di embedding**, altrimenti l'attivazione viene bloccata. I modelli di embedding possono avere due origini.

### Usare un modello di embedding via API

Prima, nella scheda [Modelli](./models.md), aggiungi un modello di embedding a un provider (per esempio `text-embedding-3-small` di OpenAI); poi torna nella scheda Conoscenza e selezionalo nella riga «Modello API».

> **Dopo averlo selezionato devi cliccare anche su «Imposta come corrente» perché abbia effetto.** Non è un passaggio superfluo: cambiare modello di embedding invalida tutti i vettori esistenti, cioè equivale a ricostruire l'indice dell'intero vault. Il clic in più serve a evitare che una scivolata sul menu a tendina ti faccia partire una ricostruzione completa.

### Usare un modello di embedding locale (senza chiave API)

Nell'area dei modelli di embedding c'è uno scaffale «**Locale**»: questi modelli girano direttamente sul tuo computer e **il contenuto delle note non lascia la macchina**.

**Solo desktop**: su mobile compaiono come non disponibili.

I modelli disponibili:

| Modello | Lingua | Dimensione | Peso | Note |
|------|------|------|------|------|
| BGE Small (English) | Inglese | 384 | circa 33 MB | Leggero |
| BGE Small (Chinese) | Cinese | 512 | circa 23 MB | Leggero, la prima scelta per un vault in cinese |
| Multilingual E5 Small | Multilingua | 384 | circa 129 MB | |
| Nomic Embed Text v1.5 | Inglese | 768 | circa 132 MB | Contesto lungo (8192 token) |
| BGE-M3 | Multilingua | 1024 | circa 560 MB (versione GPU circa 1,05 GB) | Alta qualità, pesante |
| Qwen3 Embedding (0.6B) | Multilingua | 1024 | circa 1,13 GB | Il più pesante |

Cliccando su «Scarica» vedi l'avanzamento, e a fine download i file vengono verificati. Si può scegliere tra **CPU e GPU (WebGPU)**; sui dispositivi senza supporto GPU l'opzione è disabilitata.

Sui formati di quantizzazione c'è un punto controintuitivo: **i modelli q8 (quantizzazione int8) girano solo su CPU, e su WebGPU sarebbero addirittura più lenti**. Alcuni modelli offrono una variante fp16 pensata apposta per la GPU. Qwen3, avendo un'architettura decoder-only, subirebbe una deriva dei vettori con la quantizzazione int8, quindi è disponibile solo in fp16: ed è anche il motivo per cui è il più pesante.

L'embedding locale dipende dal componente runtime «**Motore di embedding**». Se non è installato o è disattivato, ti verrà chiesto di attivarlo prima: vedi [Strumenti e permessi](./tools-and-permissions.md#componenti-runtime).

I file dei modelli stanno in una cartella del plugin stesso, **non dentro il vault, e non vengono sincronizzati**. Per eliminarli, clicca due volte sulla voce del modello per confermare.

### Attivare

Una volta a posto il modello di embedding, clicca su «**Attiva e indicizza**» nella barra di stato. L'avanzamento viene mostrato nella barra di stato e in fondo alla finestra, con la knowledge base in lavorazione, la percentuale e il nome del file corrente.

![Pagina delle impostazioni Conoscenza: in alto le schede delle knowledge base, in basso la scelta del modello di embedding e lo scaffale dei modelli locali, condivisi da tutte le knowledge base](../assets/settings-knowledge.png)

> Gli screenshot di questa documentazione usano tutti l'interfaccia in inglese. La tua interfaccia seguirà la lingua impostata in Obsidian, ma posizioni e disposizione degli elementi sono identiche.

## Più knowledge base

Puoi dividere il vault in più knowledge base indipendenti, ciascuna con il proprio ambito. Per esempio «Note di lavoro» e «Note di lettura» separate: al momento della ricerca l'AI **decide da sola quale interrogare, in base al nome e alla descrizione**.

Clicca su «**Nuova knowledge base**»; ogni knowledge base ha solo tre cose da configurare:

- **Nome** — obbligatorio, non può essere duplicato
- **Descrizione** — facoltativa, ma conviene scriverla. **Questo testo viene fornito al modello per aiutarlo a scegliere quale base consultare**
- **Ambito, inclusioni ed esclusioni** — un selettore visuale delle cartelle: passando il mouse su una cartella la contrassegni come inclusa o esclusa. Le regole si propagano alle sottocartelle, e una sottocartella può sovrascriverle. Nessuna regola = viene indicizzato l'intero vault

Sulla scheda compaiono lo stato (Pronta / In indicizzazione / Aggiornamento in sospeso / In coda / Richiede attenzione) e il numero di documenti, di chunk e lo spazio occupato.

> **Tutte le knowledge base condividono lo stesso modello di embedding**, e anche le stesse impostazioni di suddivisione in chunk. L'unica cosa davvero indipendente è l'ambito dell'indice.

## Manutenzione dell'indice

### Aggiornamento automatico

Attivo per impostazione predefinita. Dopo che hai modificato delle note, circa cinque minuti di inattività bastano perché le modifiche vengano sincronizzate nell'indice. In caso di errore ritenta con attese crescenti di 5, 15 e 30 minuti.

### Aggiornamento manuale

- **«Aggiorna ora» nella barra di stato** — sincronizza subito tutti i file modificati
- **«Ricostruisci questa base» su una singola knowledge base** — nel menu «…» della sua scheda
- **Palette dei comandi → «Aggiorna indice per file modificati»** — tutte le knowledge base, in modo incrementale
- **Palette dei comandi → «Ricostruisci indice completo del vault»** — tutte le knowledge base, ricostruzione totale

### Quando la ricostruzione manuale è obbligatoria

Alcune modifiche **non** hanno effetto da sole e richiedono una ricostruzione completa fatta a mano:

- Hai cambiato modello di embedding
- Hai cambiato la dimensione dei chunk

Queste due modifiche valgono solo per ciò che viene indicizzato da lì in avanti: i vettori esistenti non vengono ricalcolati. Ricostruisci subito dopo averle cambiate, altrimenti vecchi e nuovi vettori si mescolano e la qualità della ricerca peggiora senza una ragione apparente.

## Impostazioni avanzate

In fondo alla scheda Conoscenza c'è un gruppo di impostazioni avanzate, chiuso per impostazione predefinita. Sono tutte **globali**, non per singola knowledge base:

| Impostazione | Predefinito | Descrizione |
|------|------|------|
| **Indicizza file PDF** | Attivo | In un vault grande, disattivarlo accelera parecchio se non ti serve cercare nei PDF |
| **Dimensione chunk** | 1000 | Dopo la modifica serve ricostruire l'indice a mano perché abbia davvero effetto |
| **Similarità minima** | 0.0 | Alzandola filtri via i risultati solo vagamente pertinenti |
| **Limite** | 10 | Quanti risultati restituisce ogni ricerca |
| **Concorrenza embedding** | 10 | Intervallo 1–24. **Se vedi errori 429 di limite di frequenza, abbassala** |

> Con servizi di embedding su piano gratuito o con limiti al minuto (per esempio Azure S0), la concorrenza è la causa di errore più comune. Mentre indicizzi molte note, sparare dieci richieste tutte insieme fa scattare facilmente il limite: portarla a 2–3 di solito risolve.

Nel menu «…» della barra di stato c'è anche «**Gestisci dati indicizzati**», che mostra il totale degli embedding per ciascun modello e permette di rimuovere singole porzioni di indice.

## Come avviene la ricerca

Non devi fare niente. Quando l'AI ritiene di dover consultare le note chiama da sola lo strumento «Ricerca nel vault», che può indicare quale knowledge base interrogare (in base al nome e alla descrizione che hai scritto tu); se non ne specifica nessuna, unisce i risultati di tutte.

Se vuoi costringerlo a guardare una nota specifica, il riferimento con `@` è più diretto: il riferimento è certo, la ricerca è probabilistica.

---

## Correlato

- Come si aggiunge un modello di embedding: [Modelli e provider](./models.md)
- I permessi dello strumento di ricerca: [Strumenti e permessi](./tools-and-permissions.md)
- Scrivere partendo dalle note simili: [Sparkle](./sparkle.md)
