# CLI Agent

Se usi già strumenti AI da riga di comando come Claude Code o Codex, YOLO può pilotarli direttamente dall'interfaccia di chat e farli lavorare dentro il tuo vault: senza passare al terminale, e senza comprare API a parte.

**Solo desktop.** Tutti questi runtime devono avviare un sottoprocesso sulla macchina, quindi su mobile non sono disponibili.

## Quali sono supportati

| Runtime | Note |
|--------|------|
| **Claude Code** | Il più completo, e l'unico che supporta la modalità Plan |
| **Codex** | L'unico che permette di osservare in tempo reale l'esecuzione dei sotto-compiti |
| **Hermes** | |
| **Pi** | Si può alternare tra i due canali Pi e omp |
| **omp** (Oh My Pi) | Variante di Pi; non occupa una riga a sé, ci si entra cambiando canale dalla riga di Pi |
| **Grok** | Il più limitato in termini di capacità, vedi il confronto più sotto |

## Cosa serve prima di usarli

**Questi sono «runtime locali»**: quello che fa YOLO è avviare in locale il sottoprocesso della CLI corrispondente, non collegarsi ai loro servizi al posto tuo. Quindi:

1. Installa sul sistema lo strumento CLI corrispondente
2. Completa la sua autenticazione (per esempio, con `claude` devi aver già fatto l'accesso)

Fatto questo, YOLO rileva automaticamente l'eseguibile. Se non riesce a trovarlo, vai in **Impostazioni → YOLO → Agent → Runtime CLI** e indica a mano il percorso dell'eseguibile per quella CLI (l'output di `which claude`, o di `where claude` su Windows).

Se il percorso è sbagliato, sotto compare un avviso in rosso che dice che quel percorso non esiste su questo dispositivo, e si torna al rilevamento automatico.

> Questo percorso **è salvato solo su questo dispositivo e non viene sincronizzato con il vault**. Cambiando computer devi reinserirlo.

## Come si passa alla CLI

1. Apri una conversazione qualunque (barra laterale, scheda, divisione, finestra separata: va bene tutto)
2. Nel selettore di runtime in alto, passa da «Agent» a «CLI»
3. Compare il menu a tendina «Provider CLI»: scegline uno

Da quel momento l'intera conversazione è pilotata da quel processo CLI, e anche l'interfaccia cambia nella vista di sessione corrispondente. **Non passa più dal sistema di strumenti e permessi di YOLO**: i permessi li gestisce ciascuna CLI per conto suo.

## Come si scelgono i permessi

In alto c'è anche un gruppo di interruttori ortogonali rispetto al provider CLI: le modalità **Agent / Plan**, più un interruttore **YOLO (approvazione automatica)**.

Ogni CLI mappa questi due interruttori in modo diverso, perché i loro modelli di permessi nativi sono diversi in partenza. YOLO si limita a fornire un ingresso unificato:

**Claude Code**
- Plan → la sua modalità plan nativa
- Agent (senza YOLO) → `acceptEdits`, accetta automaticamente le modifiche ai file; gli altri strumenti seguono comunque la politica di conferma di Claude Code
- Agent + YOLO → `bypassPermissions`, salta tutte le conferme

**Codex**
- Plan → politica di approvazione `on-request` + sandbox `workspace-write` (scrittura consentita solo nello spazio di lavoro)
- Senza YOLO → come sopra
- Con YOLO → politica di approvazione `never` + sandbox `danger-full-access`, senza più distinzione tra dentro e fuori lo spazio di lavoro

**Grok** non ha l'interruttore YOLO.

> Codex non ha una modalità Plan nativa: selezionandola si ottengono i permessi equivalenti a «Agent con YOLO disattivato».

## Rispetto all'Agent nativo di YOLO, cosa cambia

Passando alla CLI **guadagni** l'ecosistema nativo di ciascuno (le loro skill, i loro MCP, i loro sistemi di plugin), ma **perdi** una serie di capacità che stanno nell'interfaccia di YOLO.

La tabella qui sotto viene dalla matrice delle capacità presente nel codice:

| Capacità | YOLO nativo | Claude Code | Codex | Hermes | Pi / omp | Grok |
|------|:---------:|:-----------:|:-----:|:------:|:--------:|:----:|
| Modalità Plan | — | ✓ | — | — | — | — |
| Interruttore YOLO di approvazione automatica | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Pannello skill nativo | — | ✓ | ✓ | — | — | — |
| Pannello stato MCP nativo | — | ✓ | ✓ | — | — | — |
| Gestione plugin | — | ✓ | — | — | — | — |
| **Selettore Agent (Assistente)** | ✓ | — | — | — | — | — |
| **Esporta conversazione nel vault** | ✓ | — | — | — | — | — |
| **Selettore modelli di YOLO** | ✓ | — | — | — | — | — |
| **Mettere in coda messaggi durante la generazione** | ✓ | — | — | — | — | — |
| Allegati immagine | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Compattazione del contesto | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Riscrivere un messaggio già inviato | — | ✓ | ✓ | — | ✓ | — |
| Osservazione in tempo reale dei sotto-compiti | — | — | ✓ | — | — | — |

Le quattro voci in grassetto sono **esclusive del YOLO nativo**: passando a una qualsiasi CLI le perdi. Quella che viene rimpianta più spesso è «Esporta conversazione nel vault»: le sessioni CLI non si possono esportare come note.

**La colonna di Grok è interamente vuota**: non supporta le immagini, non supporta la compattazione del contesto, e non ha l'interruttore di approvazione automatica. Sappilo prima di sceglierlo.

## Le sessioni vengono salvate?

Sì. Le sessioni CLI hanno un loro indice di sessione, e si ritrovano nell'elenco della cronologia delle chat dove puoi riprenderle (nella cronologia, «Le mie conversazioni» e «Conversazioni di attività» sono separate).

Ma quell'indice è **locale al dispositivo e non viene sincronizzato con il vault**. Su un altro computer non vedrai più le sessioni CLI di prima: e qui c'è una differenza rispetto alle conversazioni native di YOLO, i cui registri passano invece dalla cartella dati sincronizzabile.

## Quando conviene usarlo

**Quando la CLI è la scelta giusta**: hai già pagato un abbonamento a Claude Code o a Codex e vuoi riutilizzarne la quota; oppure il compito richiede le loro skill e il loro ecosistema MCP nativi; oppure semplicemente sei abituato a quel modo di lavorare.

**Quando è meglio restare sul YOLO nativo**: ti servono Agent con personalità diverse da alternare a seconda dell'uso; devi esportare le conversazioni come note da archiviare; vuoi cambiare liberamente tra modelli di fornitori diversi da una sola interfaccia; ti serve la cronologia delle conversazioni sincronizzata tra dispositivi.

---

## Correlato

- Tutte le capacità della chat nativa di YOLO: [Chat](./chat.md)
- Usare l'abbonamento Claude per le conversazioni native (senza passare dalla CLI): [Modelli e provider](./models.md#accedere-con-il-tuo-abbonamento-oauth)
- Come si configura l'Agent nativo: [Agent e subagent](./assistants.md)
