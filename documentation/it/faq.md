# Domande frequenti

## Installazione e avvio

### L'ho installato e non succede niente / va in conflitto con un altro plugin

**YOLO non può essere attivo insieme a [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer).** YOLO nasce come suo fork e i due entrano in conflitto. Disabilita o disinstalla prima Smart Composer.

### Come mai non c'è nemmeno una scorciatoia da tastiera?

**YOLO non assegna nessuna scorciatoia predefinita.** Su un'installazione nuova tutti i comandi sono senza associazione: devi andare in «Impostazioni → Scorciatoie da tastiera» di Obsidian, cercare il nome del comando e assegnarla tu.

È una scelta fatta per non entrare in conflitto con le scorciatoie che già usi.

---

## Modelli e richieste

### Ricevo errori CORS

Prova in quest'ordine:

1. Nelle impostazioni del provider attiva «**Nessun header stainless**»: risolve gli errori causati da header del tipo `x-stainless-os`
2. Se non basta, attiva «**Usa requestUrl di Obsidian**» per aggirare il CORS. **Il prezzo è che la risposta in streaming viene bufferizzata e restituita tutta insieme**, quindi niente effetto macchina da scrivere
3. Su desktop puoi anche impostare «Metodo richiesta di rete» su «Connessione diretta desktop»

### Le risposte non compaiono più parola per parola

Con ogni probabilità hai attivato «Usa requestUrl di Obsidian»: bufferizza l'intera risposta, ed è il prezzo inevitabile per aggirare il CORS. Se il problema di CORS è già risolto, disattivalo.

Controlla anche che «Modalita streaming risposta» non sia impostata su «Non streaming».

### I modelli di ragionamento vanno sempre in timeout

Vai in **Modelli → Criteri modello predefiniti e prompt → Timeout richiesta primaria**: i 60 secondi predefiniti sono pochi per i modelli con ragionamento pesante, alzalo.

Lascia attivo «Abilita recupero automatico» lì accanto: quando lo streaming fallisce, ritenta automaticamente una volta in modalità non streaming.

### Un modello non si elimina, clicco e non succede niente

È attualmente impostato come «Modello chat predefinito» o come «Modello per titolo conversazione». L'interfaccia non disabilita il pulsante in anticipo: il messaggio compare solo dopo che ci hai cliccato. Prima cambia il modello predefinito, poi torna a eliminarlo.

### Posso usare l'abbonamento Claude per le conversazioni normali?

Sì. Tra i provider aggiungi **Claude OAuth**; dopo l'accesso aggiungi i modelli come al solito e li selezioni normalmente nella chat. Sotto il cofano passa dal Claude Agent SDK e non da un endpoint HTTP, quindi le opzioni di trasporto come «Metodo richiesta di rete» non si applicano.

È una cosa diversa da Claude Code in [CLI Agent](./cli-agent.md): quello pilota il processo CLI installato sulla tua macchina.

---

## Chat

### Perché non sa quale nota sto guardando?

Per impostazione predefinita la chat non legge il file che hai aperto. Citalo con `@`: la prima voce del menu è di solito «File corrente».

In alternativa puoi attivare «**Sincronizzazione del focus**» nell'Agent editor, così percepisce il punto in cui ti trovi.

### Legge le mie note ma non riesce a modificarle

Probabilmente sei in modalità **Ask**. Ask non può modificare il testo delle note: passa ad **Agent**.

Attenzione però: Ask non è nemmeno del tutto in sola lettura — può eseguire operazioni di organizzazione dei file come `mkdir`, `mv`, `rm`; semplicemente non cambia le parole dentro le note.

### Non trovo la modalità Max

Max è **solo desktop**. Su mobile la modalità ricade automaticamente su Agent.

### L'utilizzo del contesto mostra solo i token, non la percentuale

Quel modello non ha configurato il valore «Token finestra di contesto». Completalo nelle impostazioni del modello e la percentuale diventerà calcolabile.

### L'annullamento è fallito

L'annullamento dipende da **snapshot locali**, e gli snapshot non vengono sincronizzati insieme alle note. Ci sono tre casi in cui fallisce:

- Stai provando ad annullare da un altro dispositivo modifiche fatte qui
- Il file è stato modificato nel frattempo
- Lo snapshot è scaduto o è andato perso

Per i contenuti che contano davvero, affidati a Git o al ripristino dei file di Obsidian.

### Posso inviare messaggi mentre sta generando?

Sì, si mettono in coda. Ma ci sono due situazioni che li bloccano: se uno strumento sta aspettando la tua approvazione devi gestirla prima, e se il modello ti sta facendo una domanda devi prima rispondere.

Se interrompi la conversazione, i messaggi in coda non ancora inviati tornano nella casella di input: non si perdono.

---

## Sparkle

### Il completamento tab non fa assolutamente niente

**Il completamento tab è disattivato per impostazione predefinita.** Vai in **Impostazioni → YOLO → Sparkle → Completamento tab** e attivalo.

Se anche dopo non si attiva, controlla due cose: primo, se le regole nella tabella dei trigger corrispondono al tuo modo di scrivere (di base si attiva solo dopo virgola, due punti, a capo ed elementi di elenco); secondo, puoi attivare «Completamento automatico dopo pausa» perché scatti anche quando smetti di scrivere.

### La `@` di Quick Ask non funziona

Quick Ask si richiama solo scrivendo il carattere di attivazione **all'inizio di una riga vuota**. Scrivere `@` in mezzo a una riga già piena è un normale inserimento di carattere.

Se hai spesso bisogno di scrivere `@` a inizio riga, puoi cambiare il carattere di attivazione nelle impostazioni.

---

## Knowledge base

### Durante l'indicizzazione ricevo errori 429 / limite di frequenza

Abbassa la **Concorrenza embedding**. Il valore predefinito è 10, troppo alto per i piani gratuiti o per i servizi con limiti al minuto (per esempio Azure S0): portarla a 2–3 di solito risolve.

### Ho cambiato la dimensione dei chunk ma i risultati di ricerca non cambiano

La dimensione dei chunk vale **solo per ciò che viene indicizzato da lì in avanti**. I vettori esistenti non vengono ricalcolati.

Vai nella palette dei comandi ed esegui «**Ricostruisci indice completo del vault**».

Lo stesso vale se cambi modello di embedding: anche lì la ricostruzione è obbligatoria.

### Ho selezionato un modello di embedding ma non ha effetto

Dopo averlo selezionato dal menu a tendina **devi cliccare anche su «Imposta come corrente»**.

Questo passaggio non è superfluo: cambiare modello di embedding invalida tutti i vettori esistenti, cioè equivale a ricostruire l'intero vault. Il clic in più serve a evitare che una scivolata faccia partire una ricostruzione completa.

### Dove si scaricano i modelli di embedding locali, e si possono eliminare?

Nell'area dei modelli di embedding della scheda Conoscenza, nello scaffale «Locale». **Solo desktop.**

I file dei modelli stanno in una cartella del plugin stesso, non dentro il vault e non sincronizzati. Per eliminarli, clicca due volte sulla voce del modello per confermare.

---

## Strumenti e permessi

### L'ambito dello spazio di lavoro si può usare come isolamento di sicurezza?

**No.** Se l'Agent ha abilitati i comandi del terminale o strumenti MCP di terze parti, l'ambito può essere aggirato: il terminale esegue una shell reale, gli MCP girano in processi esterni, e nessuno dei due passa dal controllo dei percorsi di YOLO.

Intendilo come un vincolo di autonomia — «tieni l'AI sulle cartelle giuste» — non come «chiudi l'AI in gabbia».

Se ti serve isolamento vero, la strada è non dare a quell'Agent né il terminale né MCP di cui non ti fidi, invece di affidarti all'impostazione dell'ambito.

### Perché non mi ha chiesto niente prima di cercare sul web?

**La ricerca web è impostata su «Accesso completo» per impostazione predefinita**, quindi non apre nessuna finestra. Se la cosa ti dà fastidio, vai in «Gestisci strumenti» e alza il suo livello di approvazione, oppure disattivala del tutto.

### Se attivo l'approvazione automatica, rischio un `rm -rf` sulle mie cose?

La lista di prefissi di comandi pericolosi **vale in ogni circostanza**, approvazione automatica inclusa. Di default blocca i comandi che iniziano con `rm`, `dd`, `mkfs`, `fdisk`, `shutdown`, `reboot`, `poweroff`, `halt`.

Ma è solo l'ultima linea di difesa, e non sostituisce un backup. Prima di attivare l'approvazione automatica, assicurati che il tuo vault sia sotto Git.

### MCP non funziona sul telefono

**MCP è solo desktop.** Non riguarda solo il tipo a processo locale: anche i trasporti remoti HTTP / SSE / WebSocket sono disabilitati su mobile.

### L'accesso per agenti esterni segnala un conflitto di porta

La porta predefinita 28124 è occupata; il caso più comune è una collisione con plugin tipo Local REST API. Basta cambiare porta.

---

## Dati e migrazione

### La cartella che YOLO crea nel mio vault si può rinominare?

Sì. **Impostazioni → YOLO → Altro → Manutenzione → Cartella base YOLO**, il valore predefinito è `YOLO`.

Attenzione però: è **un'operazione di spostamento**. Dopo la modifica il plugin prova a spostare il contenuto della vecchia cartella nel nuovo percorso; se il percorso di destinazione esiste già e non è vuoto, l'operazione viene rifiutata e l'impostazione precedente viene mantenuta. Fai un backup prima.

E non si può usare una cartella nascosta (non può iniziare con `.`), altrimenti Obsidian non la indicizza.

### Come porto la configurazione su un altro computer?

**Impostazioni → YOLO → Altro → Manutenzione → Export settings**: esporta in JSON e importalo sul nuovo dispositivo.

Attenzione: alcune cose sono **locali al dispositivo e non vengono trasferite**: i percorsi degli eseguibili delle CLI, la cronologia delle sessioni CLI, i file dei modelli di embedding locali, i componenti runtime.

### Cancellare gli snapshot mi fa perdere le conversazioni?

No. «Cancella snapshot e cache chat» elimina gli snapshot del contesto, gli snapshot delle modifiche e la cache delle altezze della timeline: **i messaggi della chat non vengono toccati**.

Dopo, la prima apertura di una vecchia conversazione sarà un po' più lenta (deve ricostruire contesto e disposizione): è normale, non è un danno ai dati.

Quello che elimina davvero le conversazioni è «Cancella cronologia chat».

---

## Non ho ancora risolto

Apri una issue:

- 🐛 [Segnala un bug](https://github.com/Lapis0x0/obsidian-yolo/issues/new?template=bug_report.yml)
- ✨ [Proponi un'idea](https://github.com/Lapis0x0/obsidian-yolo/issues/new?template=feature_request.yml)

Indicare la versione di Obsidian, il sistema operativo, la versione del plugin, i passi per riprodurre il problema e cosa succede davvero è quello che aiuta di più.

Se il problema riguarda le richieste ai modelli, puoi attivare **Impostazioni → YOLO → Altro → Manutenzione → Abilita debug richieste LLM**, riprodurre il problema una volta ed esportare la richiesta grezza dal pulsante Debug del messaggio. Nell'esportazione le chiavi API vengono oscurate, **ma il testo della conversazione è incluso**: controllalo prima di incollarlo da qualche parte.
