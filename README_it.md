<h1 align="center">YOLO</h1>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README_zh-CN.md">简体中文</a> | <b>Italiano</b>
</p>

<p align="center">
  <a href="./DOC/DOC_en/01-basic-introduction.md">Documentazione</a>
  ·
  <a href="https://github.com/Lapis0x0/obsidian-yolo/issues">Segnala Bug</a>
  ·
  <a href="https://github.com/Lapis0x0/obsidian-yolo/discussions">Discussioni</a>
</p>

> [!TIP]
> 🎉 **YOLO è ora ufficialmente disponibile nello Store dei Plugin della Community di Obsidian!**
>
> Ora puoi cercare e installare YOLO direttamente dai plugin della community di Obsidian senza download manuale!

> [!NOTE]
> **Forse l'assistente AI per Obsidian più flessibile, facile da usare e intelligente?**

**YOLO (You Orchestrate, LLM Operates)** è un assistente intelligente per Obsidian, progettato per l'era degli Agent.

Con YOLO puoi:

- 💬 Chattare con gli LLM direttamente nella barra laterale
- 📚 Utilizzare l'intero vault come base di conoscenza per l'AI
- ✍️ Richiamare Smart Space per continuare le tue idee ovunque
- ⚡ Usare Quick Ask per assistenza AI inline istantanea con editing intelligente
- ⌨️ Usare il completamento Tab per un'esperienza di scrittura fluida con AI
- 🧩 Abilitare funzionalità sperimentali come Learning Mode e sub-agent per esplorare workflow personalizzati
- 🎨 Godere di numerosi miglioramenti UX e perfezionamenti dell'interfaccia

YOLO continuerà ad evolversi verso l'orchestrazione di agent, la gestione di task a lungo termine e la collaborazione multi-modello, con l'obiettivo di diventare il tuo **serio assistente di apprendimento e partner di conoscenza** nell'era dei grandi modelli linguistici.

## Anteprima delle Funzionalità
Ecco un'anteprima delle capacità principali di YOLO. Esplora il plugin per maggiori dettagli:

## **💬 Conversazioni nella Barra Laterale**

https://github.com/user-attachments/assets/90bbd4f5-b73a-41b4-bf7d-85a5f44659ec

Conversazioni fluide con gli LLM, con iniezione di contesto, prompt preimpostati, provider personalizzati e parsing/generazione intelligente di Markdown.

## **🧠 Q&A sulla Base di Conoscenza**

https://github.com/user-attachments/assets/cffbada7-4314-4709-bef4-9867b43d6484

## **✍️ Smart Space**

https://github.com/user-attachments/assets/fa2d32dc-51fb-4f19-a3c3-44c2ea7a5fd9

Richiama Smart Space ovunque per una generazione di contenuti naturale, fluida ed efficiente.

## **⚡ Quick Ask**
> Le modalità di editing di questa funzionalità richiedono determinate capacità di tool-calling dal modello. Si consiglia di utilizzare i principali modelli di ragionamento.

https://github.com/user-attachments/assets/5a23e55e-482d-4e03-b564-7eac6814584e

Quick Ask è un assistente inline leggero che puoi richiamare ovunque con un carattere trigger (predefinito: `@`). Offre tre potenti modalità:

- **Modalità Domanda** 💬: Partecipa a conversazioni multi-turno e ottieni risposte istantanee
- **Modalità Modifica** ✏️: Genera modifiche strutturate con anteprima prima dell'applicazione
- **Modifica (Accesso Completo)** ⚡: Applica le modifiche generate dall'AI direttamente senza conferma

Quick Ask supporta tre tipi di operazioni di modifica:

- **CONTINUE**: Aggiungi contenuto alla fine del documento
- **REPLACE**: Sostituisci il testo esistente con versioni migliorate
- **INSERT AFTER**: Inserisci nuovo contenuto dopo un testo specifico

L'AI sceglie intelligentemente il formato appropriato in base alle tue istruzioni, rendendo l'editing dei documenti fluido ed efficiente.

## **🪡 Cursor Chat**

https://github.com/user-attachments/assets/21b775d7-b427-4da2-b20c-f2ede85c2b69

Aggiungilo con un clic—sempre a portata di mano.

## **⌨️ Completamento Tab**

https://github.com/user-attachments/assets/d19b17c8-92ac-408d-8e98-4403d5341540

Ottieni suggerimenti di completamento AI in tempo reale, rendendo la tua scrittura fluida e naturale.

## **🎛️ Supporto Multi-Modello + i18n**

Supporta più provider (OpenAI, Claude, Gemini, DeepSeek, ecc.) con cambio lingua i18n nativo.

## Per Iniziare

> [!WARNING]
> YOLO non può coesistere con [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer). Si prega di disabilitare o disinstallare Smart Composer prima di usare YOLO.

### Installazione dallo Store dei Plugin della Community (Consigliato)

1. Apri Impostazioni di Obsidian → Plugin della community
2. Clicca "Sfoglia" e cerca "YOLO"
3. Clicca "Installa" e poi "Abilita"
4. Configura la tua chiave API nelle impostazioni del plugin
   - OpenAI : [Chiavi API ChatGPT](https://platform.openai.com/api-keys)
   - Anthropic : [Chiavi API Claude](https://console.anthropic.com/settings/keys)
   - Gemini : [Chiavi API Gemini](https://aistudio.google.com/apikey)
   - Groq : [Chiavi API Groq](https://console.groq.com/keys)

### Installazione Manuale

In alternativa, puoi installare YOLO manualmente:

1. Vai alla pagina [Releases](https://github.com/Lapis0x0/obsidian-yolo/releases)
2. Scarica `main.js`, `manifest.json` e `styles.css` dall'ultima release
3. Crea una cartella chiamata `obsidian-yolo` nella directory dei plugin del tuo vault: `<vault>/.obsidian/plugins/obsidian-yolo/`
4. Copia i file scaricati in questa cartella
5. Apri Impostazioni di Obsidian → Plugin della community
6. Abilita "YOLO" nella lista dei plugin
7. Configura la tua chiave API nelle impostazioni del plugin

Per informazioni più dettagliate, consulta la [documentazione](./DOC/DOC_en/01-basic-introduction.md)

## Contribuire

Accogliamo con piacere tutti i tipi di contributi a YOLO, inclusi segnalazioni di bug, correzioni di bug, miglioramenti della documentazione e miglioramenti delle funzionalità.

**Per idee di funzionalità importanti, si prega di creare prima un issue per discutere la fattibilità e l'approccio di implementazione.**

Se sei interessato a contribuire, consulta il nostro file [CONTRIBUTING.md](CONTRIBUTING.md) per informazioni dettagliate su:

- Configurazione dell'ambiente di sviluppo
- Il nostro workflow di sviluppo
- Lavorare con lo schema del database
- Il processo per inviare pull request
- Problemi noti e soluzioni per gli sviluppatori


## Ringraziamenti

Grazie al team originale di [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer), senza di loro non esisterebbe YOLO.

## Licenza

Questo progetto è concesso in licenza sotto la [Licenza MIT](LICENSE).

## Supporta il Progetto

Se trovi YOLO utile, considera di supportare il suo sviluppo:

<p align="center"> <a href="https://afdian.com/a/lapis0x0" target="_blank"> <img src="https://img.shields.io/badge/爱发电-Supporta lo sviluppatore-fd6c9e?style=for-the-badge&logo=afdian" alt="爱发电"> </a> &nbsp; <a href="https://github.com/Lapis0x0/obsidian-yolo/blob/main/donation-qr.jpg" target="_blank"> <img src="https://img.shields.io/badge/WeChat/Alipay-Codice donazione-00D924?style=for-the-badge" alt="Codice donazione WeChat/Alipay"> </a> </p>

Aggiorno regolarmente i log di sviluppo sul mio [blog](https://www.lapis.cafe).

Il tuo supporto aiuta a mantenere e migliorare questo plugin. Ogni contributo è apprezzato e fa la differenza. Grazie per il tuo supporto!

## Cronologia delle Stelle

[![Star History Chart](https://api.star-history.com/svg?repos=Lapis0x0/obsidian-yolo&type=Date)](https://star-history.com/#Lapis0x0/obsidian-yolo&Date)
