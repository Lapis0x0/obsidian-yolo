# MCP

MCP (Model Context Protocol) è un protocollo aperto che permette all'AI di collegarsi a servizi esterni. In YOLO funziona nei due sensi:

- **Collegarsi agli altri** — far usare a YOLO strumenti esterni come GitHub, database, servizi di ricerca
- **Farsi collegare dagli altri** — permettere a client esterni come Claude Desktop di usare a loro volta il tuo vault

> **MCP è disponibile solo su desktop.** Non riguarda solo il tipo a processo locale: anche i trasporti remoti HTTP / SSE / WebSocket sono disabilitati su mobile. Nelle impostazioni mobile compare direttamente l'avviso «Gli strumenti personalizzati (MCP) non sono supportati su mobile».

## Collegare un servizio MCP esterno

Dove si entra: **Impostazioni → YOLO → Agent → Capacità globali → Strumenti → «Gestisci strumenti»**; in fondo alla finestra c'è la gestione dei server MCP, con il pulsante «**Aggiungi server strumenti personalizzati (MCP)**».

Il modulo supporta due modi di editing, a campi e in JSON, e si passa dall'uno all'altro.

### I trasporti supportati

| Tipo | Valore | Descrizione |
|------|-----|------|
| Processo locale | `stdio` | Avvia un sottoprocesso sulla tua macchina |
| Remoto | `http` | Streamable HTTP, con supporto per OAuth o header personalizzati |
| Remoto | `sse` | Server-Sent Events |
| Remoto | `ws` | WebSocket |

### Esempi di configurazione

Processo locale (prendendo come esempio l'MCP ufficiale di GitHub):

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "il tuo token"
  }
}
```

HTTP remoto, con autenticazione via header:

```json
{
  "transport": "http",
  "url": "https://example.com/mcp",
  "headers": {
    "Authorization": "Bearer il tuo token"
  }
}
```

**È compatibile anche con il formato di configurazione di Claude Desktop**: incollalo direttamente nell'editor JSON e verrà riconosciuto automaticamente.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "il tuo token" }
    }
  }
}
```

Se in `mcpServers` ci sono più server, devi indicare nel campo «Nome» quale importare. Se ce n'è uno solo, il nome viene compilato automaticamente.

### OAuth

Solo il tipo `http` lo supporta. Nel metodo di autenticazione scegli OAuth e clicca su «Connetti»: YOLO apre il browser di sistema per completare l'autorizzazione. Nella finestra vedi lo stato (in verifica / connessione in corso / connesso / fallito), e **il salvataggio è consentito solo dopo che la connessione è riuscita**.

Se in seguito rinomini quel server, le credenziali salvate vengono migrate automaticamente: non devi rifare l'autorizzazione.

### Una volta connesso

L'elenco dei server mostra per ciascuna riga nome, stato, numero di strumenti rilevati, e l'interruttore di attivazione.

Ogni Agent può poi controllare quel server singolarmente dalla propria scheda **Strumenti**:

- **Modalità di divulgazione**: «Su richiesta» mette nel prompt solo i nomi degli strumenti e carica la definizione completa al momento dell'uso; «In contesto» porta la definizione completa a ogni turno. **Per i server con molti strumenti conviene "Su richiesta"**
- **Approvazione**: Accesso completo / Richiedi approvazione / Approva solo operazioni pericolose

### Due avvertenze sui costi

**Costo in token**: il risultato restituito da uno strumento MCP entra per intero nel contesto del modello. I servizi che restituiscono molto (per esempio un'interrogazione a un database che tira su centinaia di record) alzano il consumo in modo sensibile. L'avviso è scritto anche in cima alla finestra di aggiunta.

**Confine di sicurezza**: gli strumenti MCP girano in processi esterni e **non passano dal controllo dei percorsi di YOLO**. Vuol dire che un server MCP con accesso ai file può aggirare il limite dell'[ambito dello spazio di lavoro](./tools-and-permissions.md#ambito-dello-spazio-di-lavoro-limitare-dove-esplora-da-solo). Collega solo i servizi di cui ti fidi.

## Esporre YOLO agli agent esterni

Nella direzione opposta, puoi permettere a Claude Desktop e ad altri client MCP di usare il tuo vault.

Dove si entra: **Impostazioni → YOLO → Agent → Accesso per agenti esterni** (**solo desktop**).

Attivando «Consenti accesso agli agenti esterni», YOLO avvia sulla macchina un servizio MCP su HTTP, alla porta **28124** per impostazione predefinita (scelta apposta per evitare le porte 27123/27124 usate di solito dal plugin Local REST API).

L'interfaccia ti fornisce direttamente la configurazione di connessione da incollare nel client:

```json
{
  "transport": "http",
  "url": "http://127.0.0.1:28124/mcp",
  "headers": {
    "Authorization": "Bearer <token generato automaticamente>"
  }
}
```

### Cosa viene esposto

Quattro strumenti:

| Strumento | A cosa serve |
|------|------|
| `vault_search` | Cerca nel tuo vault |
| `agent_task_start` | Indica un Agent YOLO già configurato più un'istruzione e delega l'attività in modo **asincrono**, restituendo subito un ID attività |
| `agent_task_get` | Consulta stato e risultato dell'attività |
| `agent_task_cancel` | Annulla l'attività |

In altre parole, un agent esterno non può solo cercare tra le tue note: può anche **prendere in prestito i tuoi Agent YOLO già configurati** per farsi fare il lavoro.

Le attività hanno un massimo di quattro esecuzioni concorrenti, e il loro stato evolve così: in esecuzione → (eventualmente) in attesa della conferma dell'utente → completata / fallita / annullata / interrotta.

> «In attesa della conferma dell'utente» significa che l'attività ha invocato uno strumento che richiede approvazione. A quel punto devi tornare in Obsidian e gestirla, perché l'attività possa proseguire.

**Un'attività, in sostanza, non è altro che una normale conversazione creata in background**: a lavoro finito puoi aprirla normalmente dalla cronologia delle chat di Obsidian e leggerne il registro completo. Non è un'esecuzione a scatola chiusa.

### Porta e token

In caso di conflitto sulla porta viene mostrato un avviso mirato (il caso più comune è la collisione con plugin tipo Local REST API): basta cambiare porta.

Il token viene generato automaticamente **solo alla prima attivazione**, e nell'interfaccia non c'è un pulsante dedicato per rigenerarlo. Se devi cambiarlo (per esempio perché è trapelato), disattiva e riattiva l'interruttore.

## Sulle attività pianificate

**YOLO non ha nessuna funzione integrata di attività pianificate o di cron.**

Quello che l'accesso esterno qui sopra offre sono «attività asincrone in background attivate su richiesta da un sistema esterno», non attivate da un orario. Se ti serve una vera pianificazione temporale, devi affidarti a uno strumento esterno (il cron del sistema, o la capacità di scheduling del client stesso) che chiami questa interfaccia a scadenze regolari.

---

## Correlato

- Permessi e approvazioni degli strumenti: [Strumenti e permessi](./tools-and-permissions.md)
- Configurare le preferenze MCP per singolo Agent: [Agent e subagent](./assistants.md)
- Estendere le capacità in locale senza servizi esterni: [Skill](./skills.md)
