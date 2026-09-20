# Documentazione YOLO

YOLO è un plugin per Obsidian che porta un assistente AI dentro il tuo vault: puoi conversare con le tue note, lasciargli leggere e scrivere file direttamente, interrogare l'intera knowledge base, completare e riscrivere testo nell'editor, ed estenderlo con moduli che aggiungono funzionalità complete come l'apprendimento e la lavagna infinita.

## Da qui si comincia

Appena installato il plugin, leggi queste tre pagine in ordine: bastano per iniziare a lavorare davvero.

1. **[Guida rapida](./getting-started.md)** — installazione, configurazione di un modello funzionante, prima conversazione
2. **[Modelli e provider](./models.md)** — collegare OpenAI / Claude / Gemini e altri servizi, accesso OAuth, e a cosa serve ciascun «modello predefinito»
3. **[Chat](./chat.md)** — tutto quello che l'interfaccia di chat sa fare: citare note, le modalità Ask e Agent, l'approvazione degli strumenti, scrivere le modifiche nelle note

## Uso quotidiano

- **[Sparkle](./sparkle.md)** — l'AI senza uscire dall'editor: il pannello Quick Ask, il completamento con Tab, la riscrittura della selezione, la continuazione del testo
- **[Knowledge base e ricerca](./knowledge-base.md)** — indicizzare il vault perché le risposte abbiano delle fonti, gestire più knowledge base, e i modelli di embedding locali che non richiedono alcuna chiave API
- **[Strumenti e permessi](./tools-and-permissions.md)** — cosa può fare YOLO al tuo vault, come funziona il meccanismo di approvazione, come confinarlo in cartelle specifiche

## Farsi capire meglio

- **[Memoria](./memory.md)** — far ricordare a YOLO le tue preferenze e il contesto di lungo periodo da una conversazione all'altra
- **[Agent e subagent](./assistants.md)** — configurare agent dedicati a scenari diversi, e delegare i compiti grossi a dei subagent
- **[Skill](./skills.md)** — insegnare a YOLO a fare le cose a modo tuo con un solo file Markdown

## Avanzato

- **[MCP](./mcp.md)** — collegare servizi MCP esterni per estendere le capacità, ed esporre la ricerca nel vault di YOLO ad altri agent
- **[CLI Agent](./cli-agent.md)** — pilotare da desktop Claude Code, Codex e altri strumenti già autenticati sulla tua macchina
- **[Moduli](./modules.md)** — il sistema dei moduli, e come si usano il modulo Apprendimento e il modulo Lavagna

## Consultazione

- **[Riferimento delle impostazioni](./settings-reference.md)** — voce per voce, le sei schede della pagina impostazioni
- **[Domande frequenti](./faq.md)** — diagnosi degli errori e dubbi ricorrenti

---

## Su questa documentazione

Questa documentazione è scritta e mantenuta da **Claude**, sulla base del comportamento reale del codice attuale.

Il vantaggio è che copre parecchi dettagli sepolti in fondo alle impostazioni, di quelli che normalmente nessuno mette per iscritto; il rischio è che anche le macchine sbagliano, soprattutto sulle affermazioni negative del tipo «questa funzione non supporta quel caso». **Quando la documentazione e l'interfaccia non coincidono, l'interfaccia ha ragione**: in quel caso [apri una issue](https://github.com/Lapis0x0/obsidian-yolo/issues/new?template=bug_report.yml) e faccelo sapere — un errore nella documentazione merita di essere corretto quanto un bug nel codice.

Se finisci una sezione e ancora non sai dove cliccare, segnalacelo lo stesso.

Per contribuire allo sviluppo, vedi [CONTRIBUTING.md](../../CONTRIBUTING.md).
