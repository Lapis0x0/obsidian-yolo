# Modelli e provider

YOLO non fornisce modelli propri: devi collegarne almeno uno. Questa pagina spiega come collegarli, come regolarli, e a cosa serve ciascuno dei vari «modelli predefiniti».

Dove si configura: **Impostazioni → YOLO → Modelli**.

## Provider

Un «provider» è l'origine di un modello: un fornitore di API, oppure un servizio di inferenza che gira sulla tua macchina. Clicca su «**Aggiungi provider**» per aprire il selettore, diviso in queste categorie:

| Categoria | Contiene |
|------|------|
| **Internazionale** | OpenAI, Anthropic, Gemini, Mistral, Perplexity, Groq, xAI, Together AI, Cerebras, SambaNova, Morph |
| **Cina** | DeepSeek, Moonshot, Zhipu, Doubao, SiliconFlow, StepFun, MiniMax, Hunyuan, Xiaomi MiMo |
| **Aggregatori** | OpenRouter, APIMart, Fluxion AI |
| **Cloud** | Azure OpenAI, Amazon Bedrock |
| **Locali** | Ollama, LM Studio |

Nel selettore c'è anche una scheda a parte, «**Provider personalizzato**», per qualunque endpoint compatibile con OpenAI.

### Provider personalizzato

Proxy inversi, gateway auto-ospitati e servizi non inclusi tra quelli predefiniti passano tutti da qui. I campi da compilare:

- **ID provider** — serve solo a distinguerlo nella tua lista, scegli quello che vuoi
- **Chiave API** — lasciala vuota se non serve
- **URL base** — per esempio `https://api.example.com/v1`. Nel modulo c'è un'«Anteprima:» che mostra l'indirizzo completo effettivamente composto: utilissima quando hai sbagliato a scrivere

C'è poi un gruppo di opzioni avanzate che normalmente non si toccano, ma che diventano la cura quando qualcosa non funziona:

| Opzione | Quando serve |
|------|-------------|
| **Nessun header stainless** | Quando incontri errori CORS causati da header del tipo `x-stainless-os` |
| **Usa requestUrl di Obsidian** | Aggira le restrizioni CORS. **Il prezzo da pagare è che la risposta in streaming viene bufferizzata e restituita tutta insieme**, quindi perdi l'effetto macchina da scrivere |
| **Metodo richiesta di rete** | Auto (consigliato) / Richiesta browser / Richiesta integrata Obsidian / Connessione diretta desktop. Su desktop conviene «Connessione diretta desktop»; su mobile, se le richieste browser danno problemi, passa a «Richiesta integrata Obsidian» |
| **Modalita streaming risposta** | Auto (predefinito) / Streaming / Non streaming. Passa manualmente a «Non streaming» quando l'upstream non supporta lo streaming |
| **Cache del prompt** | Solo per la famiglia Anthropic, attiva per impostazione predefinita. Vedi la nota qui sotto |
| **Header personalizzati** | Quando servono header aggiuntivi di autenticazione o di routing |

> **Sulla cache del prompt**: le scritture in cache di Anthropic hanno un sovrapprezzo di circa il 25%, ma le letture che colpiscono la cache costano circa il 10% del prezzo pieno. Più la conversazione è lunga e più il prefisso si ripete, più conviene: per questo è attiva di default. Va disattivata solo se l'endpoint upstream non supporta o gestisce male il campo `cache_control`.

### Accedere con il tuo abbonamento (OAuth)

Se hai già un abbonamento a ChatGPT Plus / Pro oppure a Claude, puoi usare direttamente la quota del tuo account senza comprare API a parte. Nel selettore dei provider cerca le voci con il badge **OAuth**:

**ChatGPT OAuth** — due modi per accedere:
- **Accesso dal browser**: al clic si apre il browser di sistema per l'autorizzazione (**solo desktop**)
- **Accesso con codice dispositivo**: mostra un codice da inserire entro 15 minuti nella pagina di autorizzazione. Non occupa una porta locale, quindi è la scelta giusta quando hai conflitti di porte

**Gemini OAuth** — clicca su «Connetti» per l'autorizzazione dal browser, **solo desktop**. Una volta connesso mostra l'email dell'account e l'ID del progetto.

**Claude OAuth** — usa la quota dell'abbonamento Claude per le conversazioni normali. Ci sono due modi per ottenere il token:
- **Accesso automatico** (solo desktop): un clic, e YOLO esegue `claude setup-token` da solo e compila il campo
- **Manuale**: esegui tu `claude setup-token` in un terminale e incolla il token nel campo. Su Windows anche l'accesso automatico apre una finestra di terminale, dove completi la procedura e poi incolli il risultato

Dopo l'accesso aggiungi i modelli chat come al solito e li selezioni normalmente nella chat: non c'è nessuna differenza rispetto agli altri provider.

> C'è una differenza tecnica rispetto agli altri provider: le richieste passano dal **Claude Agent SDK**, non da un endpoint HTTP. Per questo non ha opzioni come «Metodo richiesta di rete» o «Modalita streaming risposta», che agiscono sul livello di trasporto: quelle impostazioni qui non si applicano.

A connessione avvenuta il pannello mostra lo stato e la scadenza del token, e puoi disconnetterti in qualsiasi momento. Quando il token scade basta rifare l'accesso o incollarne uno nuovo.

## Aggiungere modelli

Aggiunto il provider, espandi la sua scheda e clicca su «**Aggiungi modello chat**».

- **Modalità «Singolo»**: cerca e seleziona dalla lista dei modelli disponibili recuperata automaticamente, oppure compila a mano «ID modello» e «Nome modello»
- **Modalità «In blocco»**: spunti più modelli e li aggiungi tutti insieme con le impostazioni predefinite, per poi regolarli uno per uno in seguito

Nell'intestazione c'è anche un «**Test di connettività**», che manda una richiesta di prova a un singolo modello o a tutti e restituisce OK / Fallito / Timeout, riportando anche la latenza del primo token. Usalo appena finisci di configurare, o quando sospetti che un modello non risponda più.

> Un modello impostato come «Modello chat predefinito» o come «Modello per titolo conversazione» **non può essere eliminato, né disattivato**. L'interfaccia non disabilita il pulsante in anticipo: il messaggio compare solo dopo che ci hai cliccato. Prima cambia il modello predefinito, poi torna a eliminarlo.

### Parametri del modello

Ogni modello si configura singolarmente:

**Tipo di ragionamento** — sbagliare questa voce fa comportare male i modelli di ragionamento:

| Tipo | Parametri associati |
|------|---------|
| Modello non ragionante / predefinito | nessuno |
| Stile reasoning_effort OpenAI | Sforzo di ragionamento: minimal (solo GPT-5) / low / medium / high |
| Stile thinking_budget Gemini | Budget di pensiero, misurato in token. `0` disattiva il ragionamento, `-1` lo assegna dinamicamente |
| Anthropic extended thinking | adaptive + effort |
| Modello di ragionamento generico | nessuno |

**Modalità di input** — Testo, Immagini, PDF (nativo). **È una dichiarazione, non un interruttore**: spuntare una modalità che il modello non supporta fa fallire direttamente la chiamata; e se non la spunti, non potrai caricare immagini nella chat nemmeno se il modello le supporta.

**Strumenti integrati del provider** — le capacità lato server di Gemini, OpenAI, OpenRouter, Grok e DeepSeek (per esempio la loro ricerca web). Sono una cosa del tutto separata dalla ricerca web di YOLO. Attenzione: **quando attivi la ricerca web ufficiale di DeepSeek, lo strumento di ricerca web di YOLO viene disattivato automaticamente**, per evitare che due sistemi di ricerca si pestino i piedi.

**Token finestra di contesto** — viene compilato automaticamente per i modelli più comuni. Questo valore non è decorativo: la percentuale di contesto occupato di cui si parla in [Chat](./chat.md#quanto-contesto-stai-usando) si può calcolare solo grazie a questo numero.

Ci sono poi **Token massimi in output**, il pannello dei parametri di richiesta (interruttori campo per campo: se non li attivi valgono i valori predefiniti del provider) e i **Parametri personalizzati** (campi aggiuntivi di qualunque tipo: testo, numero, booleano o JSON).

I modelli di embedding hanno in più un campo **Dimensione**, di solito rilevato automaticamente ma compilabile anche a mano.

## A cosa serve ciascun modello predefinito

In YOLO non c'è un solo modello predefinito, ma diverse caselle indipendenti tra loro. Capire come si dividono il lavoro fa risparmiare parecchio: per esempio puoi affidare i titoli delle conversazioni a un modello piccolo ed economico.

| Casella | Dove si configura | Dove viene usata |
|------|--------|--------|
| **Modello chat predefinito** | Modelli → Criteri modello predefiniti e prompt | Il modello usato da tutte le interfacce di chat |
| **Modello per titolo conversazione** | Come sopra | Genera automaticamente il titolo dal primo messaggio. **Qui sta benissimo un modello piccolo ed economico** |
| **Modello embedding** | Scheda Conoscenza | Uno solo, condiviso da tutte le knowledge base. Cambiarlo significa invalidare tutti gli indici |
| **Modello di continuazione** | Impostazioni Sparkle | Usato dalla modalità di continuazione di Quick Ask e dalla riscrittura della selezione. **È anche il ripiego del completamento tab** |
| **Modello completamento tab** | Impostazioni Sparkle | Il completamento tab usa prima questo; **se lo lasci vuoto ricade sul modello di continuazione** |

## Prompt di sistema globale

Nella sezione «Criteri modello predefiniti e prompt» c'è una casella di testo **Prompt di sistema globale**: il suo contenuto viene aggiunto all'inizio di ogni conversazione.

C'è qui un trucco poco visibile ma molto utile: **puoi incorporare il testo completo di una nota scrivendo `![[Nota]]`**. In pratica puoi mettere per iscritto le tue preferenze di scrittura, il glossario dei termini o il contesto di un progetto in una nota, e citarla nel prompt di sistema: da quel momento modificare la nota equivale a modificare il prompt, senza tornare nelle impostazioni.

La stessa sintassi funziona anche nel prompt di sistema di ogni singolo Agent, vedi [Agent](./assistants.md).

## Quando la richiesta fallisce

Nella stessa sezione ci sono altre due impostazioni legate alla stabilità:

- **Abilita recupero automatico** (attivo per impostazione predefinita) — quando la richiesta in streaming va in timeout o fallisce, ritenta automaticamente una volta in modalità non streaming
- **Timeout richiesta primaria** (predefinito 60 secondi) — i modelli di ragionamento pensano a lungo e sbattono facilmente contro questo limite. Se usi modelli con ragionamento pesante e vai spesso in timeout, alzalo

Altri spunti di diagnosi nelle [Domande frequenti](./faq.md).

---

## Correlato

- Prima configurazione: [Guida rapida](./getting-started.md)
- Modelli di embedding e inferenza locale: [Knowledge base e ricerca](./knowledge-base.md)
- Usare uno strumento CLI già autenticato al posto delle API: [CLI Agent](./cli-agent.md)
