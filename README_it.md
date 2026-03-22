<h1 align="center">YOLO</h1>
<p align="center"><b>You Orchestrate, LLM Operates.</b></p>

<p align="center">
  Assistente AI native per Obsidian — chat, scrittura, knowledge base e orchestrazione, tutto in un unico posto.
</p>

<p align="center"><a href="https://github.com/Lapis0x0/obsidian-yolo/stargazers">
    <img src="https://img.shields.io/github/stars/Lapis0x0/obsidian-yolo?style=flat-square&color=6c5ce7" alt="GitHub Stars">
  </a>
  <a href="https://github.com/Lapis0x0/obsidian-yolo/releases/latest">
    <img src="https://img.shields.io/github/v/release/Lapis0x0/obsidian-yolo?style=flat-square&color=00b894" alt="Latest Release">
  </a>
  <a href="https://github.com/Lapis0x0/obsidian-yolo/releases">
    <img src="https://img.shields.io/github/downloads/Lapis0x0/obsidian-yolo/total?style=flat-square&color=0984e3" alt="Downloads">
  </a>
  <a href="https://github.com/Lapis0x0/obsidian-yolo/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/Lapis0x0/obsidian-yolo?style=flat-square&color=636e72" alt="License">
  </a>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README_zh-CN.md">简体中文</a> | <b>Italiano</b>
</p>

## Novita recenti

- `1.5.2`: Il nuovo sistema di memoria e ora disponibile e permette a YOLO di ricordare in modo piu naturale le tue preferenze, abitudini e il contesto a lungo termine tra conversazioni diverse.
- `1.5.1`: YOLO introduce una nuovissima modalita Agent: l'AI non si limita piu a rispondere, ma puo usare strumenti, organizzare passaggi e partecipare davvero al lavoro da svolgere.

## Highlights

### 🤖 Modalità Agent

La modalità Agent di YOLO permette ai LLM di andare oltre le semplici "macchine Q&A" — possono realmente operare sul tuo Vault.

| Tool Calling + MCP | Skills Personalizzati |
|:--:|:--:|
| ![Agent Tools](./assets/agenttools.gif) | ![Agent Skills](./assets/agentskills.gif) |
| Configura liberamente le catene di strumenti per permettere agli Agent di leggere, scrivere, modificare e organizzare i tuoi file direttamente | Incapsula esperienze e SOP in skill riutilizzabili, invoca con una singola frase — lascia che l'Agent funzioni come te |

| Chat Multi-Finestra | Quick Ask |
|:--:|:--:|
| ![Chat Window](./assets/chatwindow.gif) | ![Quick Ask](./assets/Quickask.gif) |
| Gestisci in parallelo task e contesti diversi su più finestre di chat, rendendo il multitasking più naturale | Attivalo con un carattere (predefinito `@`) per un assistente inline che supporta Q&A, modifica e continuazione, rendendo l'editing dei documenti senza interruzioni |

### 🧠 Q&A Knowledge Base + ✍️ Smart Space

| Q&A Knowledge Base | Smart Space |
|:--:|:--:|
| ![RAG Vault](./assets/ragvault.gif) | ![Smart Space](./assets/Smartspace.gif) |
| Trasforma l'intero Vault nella knowledge base dell'AI: con RAG, YOLO risponde usando il contesto reale dei tuoi appunti invece di output generici | Richiamalo ovunque per continuare liberamente il tuo flusso creativo con una generazione di contenuti fluida |

## Funzionalità

Oltre alle capacità principali sopra descritte, YOLO fornisce anche:

| Funzionalità | Descrizione |
|--------------|-------------|
| 💬 Chat Sidebar | Conversazione seamless con LLM, iniezione di contesto, prompt preimpostati, parsing smart di Markdown |
| 🧠 Sistema di memoria | Permette a YOLO di ricordare preferenze, abitudini e contesto a lungo termine per conversazioni piu coerenti |
| 🪡 Cursor Chat | Aggiunta contesto con un click, conversazione a portata di mano |
| ⌨️ Completamento Tab | Completamento AI in tempo reale per una scrittura più fluida e naturale |
| 🎛️ Supporto Multi-Modello | OpenAI, Claude, Gemini, DeepSeek e altri modelli mainstream, liberamente commutabili |
| 🌍 i18n | Supporto nativo multi-lingua |
| 🧩 Funzionalità Sperimentali | Learning Mode, sub-Agents, esplora workflow personalizzati |

## Quick Start

1. Apri Impostazioni Obsidian → Plugin Community → Browse → Cerca **"YOLO"**
2. Installa e abilita
3. Configura la tua API key nelle impostazioni del plugin:
   - [OpenAI](https://platform.openai.com/api-keys) / [Anthropic](https://console.anthropic.com/settings/keys) / [Gemini](https://aistudio.google.com/apikey) / [Groq](https://console.groq.com/keys)
4. Apri la sidebar per iniziare a chattare — oppure prova Quick Ask digitando `@` nell'editor

## Installazione

### Store Plugin Community (Consigliato)

Vedi Quick Start sopra.

### Installazione Manuale

1. Vai su [Releases](https://github.com/Lapis0x0/obsidian-yolo/releases) e scarica l'ultima versione di `main.js`, `manifest.json`, `styles.css`
2. Crea la cartella: `<vault>/.obsidian/plugins/obsidian-yolo/`
3. Copia i file in quella cartella, poi abilita il plugin nelle Impostazioni di Obsidian

> [!WARNING]
> YOLO non può coesistere con [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer). Disabilita o disinstalla Smart Composer prima di usare YOLO.

## Roadmap

- [ ] Ricerca Vault AI migliore e più forte
- [ ] Agent in Background (automazione task lunghi)
- [ ] Task programmati Cron
- [ ] Orchestrazione Multi-Agent
- [ ] Learning Mode
- [ ] Lavagna AI migliore

## Contribuire

Sono benvenuti tutti i tipi di contributo — segnalazioni bug, miglioramenti documentazione, miglioramenti funzionalità.

**Per funzionalità maggiori, apri prima una issue per discutere fattibilità e implementazione.**

## Riconoscimenti

Grazie a [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) per il lavoro originale — senza di loro, YOLO non esisterebbe.

Ringraziamenti speciali a [Kilo Code](https://kilo.ai) per il loro sponsorship. Kilo è una piattaforma open-source di assistenti AI con 500+ modelli AI, che aiuta gli sviluppatori a costruire e iterare più velocemente.

<p align="center">
  <a href="https://kilo.ai" target="_blank">
    <img src="https://img.shields.io/badge/Sponsored_by-Kilo_Code-FF6B6B?style=for-the-badge" alt="Sponsored by Kilo Code" height="30">
  </a>
</p>

## Supporto

Se trovi YOLO utile, considera di supportare il progetto:

<p align="center">
  <a href="https://afdian.com/a/lapis0x0" target="_blank">
    <img src="https://img.shields.io/badge/爱发电-Support Developer-fd6c9e?style=for-the-badge" alt="爱发电">
  </a>
  &nbsp;
  <a href="https://github.com/Lapis0x0/obsidian-yolo/blob/main/donation-qr.jpg" target="_blank">
    <img src="https://img.shields.io/badge/WeChat/Alipay-Donation QR-00D924?style=for-the-badge" alt="WeChat/Alipay Donation QR">
  </a>
</p>

I log di sviluppo sono regolarmente aggiornati sul [blog](https://www.lapis.cafe).

## Licenza

[MIT License](LICENSE)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Lapis0x0/obsidian-yolo&type=Date)](https://star-history.com/#Lapis0x0/obsidian-yolo&Type=Date)
