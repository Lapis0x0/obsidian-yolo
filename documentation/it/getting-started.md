# Guida rapida

Questa pagina ti porta da zero a YOLO installato, con un modello funzionante e la prima conversazione conclusa. In tutto, cinque minuti circa.

## Installazione

### Dal marketplace dei plugin della community (consigliato)

1. Apri le impostazioni di Obsidian → **Plugin della community** → **Sfoglia**
2. Cerca **YOLO**
3. Clicca su installa, poi abilitalo

### Installazione manuale

1. Scarica dalle [Releases](https://github.com/Lapis0x0/obsidian-yolo/releases) i file `main.js`, `manifest.json` e `styles.css` della versione più recente
2. Crea nel vault la cartella `<il tuo vault>/.obsidian/plugins/obsidian-yolo/`
3. Metti dentro i tre file, torna nelle impostazioni di Obsidian e abilita il plugin

> **YOLO non può essere attivo insieme a [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer).** YOLO nasce come fork di Smart Composer e i due entrano in conflitto. Disabilita o disinstalla prima Smart Composer.

## Configurare un modello funzionante

Appena installato, YOLO non può ancora lavorare: gli serve un modello. Apri **Impostazioni → YOLO → Modelli**.

### Primo passo: aggiungere un provider

Clicca su «**Aggiungi provider**»: si apre un selettore diviso in categorie per area geografica e tipo:

- **Internazionale**: OpenAI, Anthropic, Gemini, Mistral, Groq, xAI e altri
- **Cina**: DeepSeek, Moonshot, Zhipu, Doubao, SiliconFlow, MiniMax e altri
- **Aggregatori**: OpenRouter, APIMart, Fluxion AI — una sola chiave per i modelli di più fornitori
- **Cloud**: Azure OpenAI, Amazon Bedrock
- **Locali**: Ollama, LM Studio — il modello gira sul tuo computer
- **Provider personalizzato**: qualunque endpoint compatibile con OpenAI, basta indicare URL base e chiave API

Scegline uno e inserisci la chiave API. Le chiavi dei servizi più diffusi si richiedono qui:

- [OpenAI](https://platform.openai.com/api-keys)
- [Anthropic](https://console.anthropic.com/settings/keys)
- [Gemini](https://aistudio.google.com/apikey)
- [Groq](https://console.groq.com/keys)

> **Non vuoi pagare per le API?** Se hai già un abbonamento a ChatGPT Plus o a Claude, nell'elenco dei provider cerca le voci con il badge **OAuth** (ChatGPT OAuth, Gemini OAuth, Claude OAuth): accedi con il tuo account e riutilizzi la quota dell'abbonamento, senza bisogno di una chiave API. Vedi [Modelli e provider](./models.md#accedere-con-il-tuo-abbonamento-oauth).

### Secondo passo: aggiungere un modello

Una volta aggiunto il provider, espandi la sua scheda e clicca su «**Aggiungi modello chat**».

Puoi scegliere dalla lista dei modelli disponibili recuperata automaticamente, oppure inserire a mano l'ID del modello. Se vuoi aggiungerne parecchi in una volta, passa alla **modalità di aggiunta «In blocco»** e spunta quelli che ti servono.

![Pagina delle impostazioni Modelli: espandendo un provider si vede l'elenco dei suoi modelli chat](../assets/settings-models.png)

> Gli screenshot di questa documentazione usano tutti l'interfaccia in inglese. La tua interfaccia seguirà la lingua impostata in Obsidian, ma posizioni e disposizione degli elementi sono identiche.

### Terzo passo: impostarlo come predefinito

Scorri fino alla sezione «**Criteri modello predefiniti e prompt**», in fondo alla scheda Modelli, e imposta il modello appena aggiunto come «**Modello chat predefinito**».

## La prima conversazione

Clicca sull'icona YOLO nella barra laterale sinistra per aprire il pannello di chat, e scrivi qualcosa per provare.

Per fargli leggere le tue note, scrivi `@` nella casella di input: la prima voce del menu è di solito **File corrente**. Selezionala e poi fai la tua domanda, per esempio «riassumi i punti chiave di questa nota».

### Prima di tutto, le tre modalità

Accanto alla casella di input c'è un menu a tendina per la modalità. È l'interruttore più importante di YOLO, perché decide **cosa gli è permesso fare**:

| Modalità | Cosa può fare | Quando usarla |
|------|-----------|-----------|
| **Ask** | Legge le note, cerca, naviga il web, ma **non tocca il testo delle tue note** | Domande, riassunti, proposte di riscrittura |
| **Agent** | Tutto quello di Ask, più **modificare le note**, eseguire attività in più passi, usare il terminale | Quando vuoi che ti sistemi davvero le note e riordini il vault |
| **Max** | Legge e scrive **qualsiasi file della macchina**, non solo il vault (solo desktop) | Lavori che escono da Obsidian; è il livello di permessi più alto |

Se sei alle prime armi, resta su **Ask** per un po'; passa a **Agent** quando ti serve che metta mano alle note.

La spiegazione completa delle modalità, e dell'interruttore ad alto rischio «approvazione automatica», è in [Chat](./chat.md#ask-agent-e-max).

## Modificare le note richiede il tuo consenso

In modalità Agent il modello non sovrascrive direttamente i tuoi file. Prima ti mostra un diff, e solo quando clicchi su «Applica» il contenuto viene scritto davvero; sotto ogni turno di modifiche c'è anche un modo per annullare.

Attenzione però: **l'annullamento dipende da snapshot locali, che non vengono sincronizzati insieme alle note**. Per i contenuti importanti continua ad affidarti a Git o al ripristino dei file di Obsidian.

## E adesso?

Saper chattare è solo il punto di partenza. Scegli una direzione in base a quello che ti serve:

- **Voglio che risponda basandosi su tutto il vault** → [Knowledge base e ricerca](./knowledge-base.md): indicizza il vault perché le risposte abbiano delle fonti. Sono supportati anche modelli di embedding locali che non richiedono chiavi API.
- **Voglio usare l'AI mentre scrivo** → [Sparkle](./sparkle.md): completamento con Tab, riscrittura della selezione, pannello Quick Ask, tutto senza uscire dall'editor.
- **Ho paura che mi rovini i file** → [Strumenti e permessi](./tools-and-permissions.md): cosa può fare esattamente, e come confinarlo in cartelle specifiche.
- **Voglio che ricordi le mie preferenze** → [Memoria](./memory.md)
- **Voglio configurare più ruoli con scopi diversi** → [Agent](./assistants.md)

Se incontri problemi, parti dalle [Domande frequenti](./faq.md).
