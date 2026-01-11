import { TranslationKeys } from '../types'

export const it: TranslationKeys = {
  commands: {
    openChat: 'Apri chat',
    addSelectionToChat: 'Aggiungi selezione alla chat',
    addFileToChat: 'Aggiungi file alla chat',
    addFolderToChat: 'Aggiungi cartella alla chat',
    rebuildVaultIndex: 'Ricostruisci indice completo del vault',
    updateVaultIndex: 'Aggiorna indice per file modificati',
    continueWriting: 'AI continua scrittura',
    continueWritingSelected: 'AI continua scrittura (selezione)',
    customContinueWriting: 'AI continua personalizzato',
    customRewrite: 'AI riscrivi personalizzato',
    triggerSmartSpace: 'Attiva smart space',
    triggerQuickAsk: 'Attiva quick ask',
    triggerTabCompletion: 'Attiva completamento tab',
    acceptInlineSuggestion: 'Accetta completamento',
  },

  common: {
    save: 'Salva',
    cancel: 'Annulla',
    delete: 'Elimina',
    edit: 'Modifica',
    add: 'Aggiungi',
    clear: 'Cancella',
    remove: 'Rimuovi',
    confirm: 'Conferma',
    close: 'Chiudi',
    loading: 'Caricamento...',
    error: 'Errore',
    success: 'Successo',
    warning: 'Avviso',
    retry: 'Riprova',
    copy: 'Copia',
    paste: 'Incolla',
    default: 'Predefinito',
    modelDefault: 'Predefinito del modello',
    on: 'Attivo',
    off: 'Disattivo',
    noResults: 'Nessuna corrispondenza trovata',
  },

  sidebar: {
    tabs: {
      chat: 'Chat',
      composer: 'Sparkle',
    },
    chatList: {
      searchPlaceholder: 'Cerca conversazioni',
      empty: 'Nessuna conversazione',
    },
    composer: {
      title: 'Sparkle',
      subtitle:
        'Configura i parametri di continuazione e il contesto prima di generare.',
      backToChat: 'Torna alla chat',
      modelSectionTitle: 'Modello',
      continuationModel: 'Modello di continuazione',
      continuationModelDesc:
        'Quando la super continuazione è abilitata, questa vista usa questo modello per le attività di continuazione.',
      contextSectionTitle: 'Fonti di contesto',
      ragToggle: 'Abilita recupero con embeddings',
      ragToggleDesc:
        'Recupera note simili tramite embeddings prima di generare nuovo testo.',
      sections: {
        modelWithPrompt: {
          title: 'Modello e prompt',
        },
        model: {
          title: 'Selezione modello',
          desc: 'Scegli quale modello alimenta queste attività.',
        },
        parameters: {
          title: 'Parametri',
          desc: 'Regola i parametri per il modello usato in questa vista.',
        },
        context: {
          title: 'Gestione contesto',
          desc: 'Dai priorità alle fonti di contenuto referenziate quando questa vista viene eseguita.',
        },
      },
      continuationPrompt: 'Prompt di sistema per continuazione',
      maxContinuationChars: 'Caratteri massimi di continuazione',
      referenceRulesTitle: 'Regole di riferimento',
      referenceRulesPlaceholder:
        'Seleziona le cartelle il cui contenuto deve essere completamente iniettato.',
      knowledgeBaseTitle: 'Base di conoscenza',
      knowledgeBasePlaceholder:
        'Seleziona cartelle o file usati come ambito di recupero (lascia vuoto per tutti).',
      knowledgeBaseHint:
        "Abilita la ricerca embeddings per limitare l'ambito di recupero.",
    },
  },

  smartSpace: {
    webSearch: 'Web',
    urlContext: 'URL',
    mentionContextLabel: 'File menzionati',
  },

  selection: {
    actions: {
      addToChat: 'Aggiungi alla chat',
      rewrite: 'AI riscrivi',
      explain: 'Spiega in dettaglio',
    },
  },

  settings: {
    title: 'Impostazioni Yolo',
    supportSmartComposer: {
      name: 'Supporta il progetto',
      desc: 'Se trovi utile questo plugin, considera di supportarne lo sviluppo!',
      buyMeACoffee: 'Offrimi un caffè',
    },
    defaults: {
      title: 'Modelli e prompt predefiniti',
      defaultChatModel: 'Modello chat predefinito',
      defaultChatModelDesc:
        'Scegli il modello che vuoi usare per la chat nella barra laterale.',
      toolModel: 'Modello strumento',
      toolModelDesc:
        'Seleziona il modello usato globalmente come modello strumento (per la denominazione automatica delle conversazioni, operazioni di applicazione, ecc.).',
      globalSystemPrompt: 'Prompt di sistema globale',
      globalSystemPromptDesc:
        "Questo prompt viene aggiunto all'inizio di ogni conversazione chat.",
      continuationSystemPrompt:
        'Prompt di sistema di continuazione predefinito',
      continuationSystemPromptDesc:
        'Usato come messaggio di sistema quando si genera testo di continuazione; lascia vuoto per usare quello predefinito incorporato.',
      chatTitlePrompt: 'Prompt titolo chat',
      chatTitlePromptDesc:
        'Prompt usato quando si generano automaticamente i titoli delle conversazioni dal primo messaggio utente.',
      baseModelSpecialPrompt: 'Prompt speciale modello base',
      baseModelSpecialPromptDesc:
        'Parole prompt speciali usate come modello base.',
      tabCompletionSystemPrompt: 'Prompt di sistema completamento tab',
      tabCompletionSystemPromptDesc:
        'Messaggio di sistema applicato quando si generano suggerimenti di completamento tab; lascia vuoto per usare quello predefinito incorporato.',
    },
    smartSpace: {
      quickActionsTitle: 'Azioni rapide smart space',
      quickActionsDesc:
        'Personalizza le azioni rapide e i prompt visualizzati nello smart space',
      configureActions: 'Configura azioni rapide',
      actionsCount: 'Azioni rapide configurate: {count}',
      addAction: 'Aggiungi azione',
      resetToDefault: 'Ripristina predefiniti',
      confirmReset:
        'Sei sicuro di voler ripristinare le azioni rapide predefinite ed eliminare tutte le impostazioni personalizzate?',
      actionLabel: 'Etichetta azione',
      actionLabelDesc: "Testo visualizzato nell'azione rapida",
      actionLabelPlaceholder: 'Ad esempio, continua a scrivere',
      actionInstruction: 'Prompt',
      actionInstructionDesc: "Istruzione inviata all'AI",
      actionInstructionPlaceholder:
        'Ad esempio, continua il testo corrente nello stesso stile e tono',
      actionCategory: 'Categoria',
      actionCategoryDesc: 'Gruppo in cui viene visualizzata questa azione',
      actionIcon: 'Icona',
      actionIconDesc: 'Icona visiva per questa azione',
      actionEnabled: 'Abilitata',
      actionEnabledDesc: 'Mostra questa azione nello smart space',
      moveUp: 'Sposta su',
      moveDown: 'Sposta giù',
      duplicate: 'Duplica',
      disabled: 'Disabilitata',
      categories: {
        suggestions: 'Suggerimenti',
        writing: 'Scrittura',
        thinking: 'Pensiero',
        custom: 'Personalizzato',
      },
      iconLabels: {
        sparkles: 'Scintille',
        file: 'File',
        todo: 'Da fare',
        workflow: 'Flusso di lavoro',
        table: 'Tabella',
        pen: 'Penna',
        lightbulb: 'Lampadina',
        brain: 'Cervello',
        message: 'Messaggio',
        settings: 'Impostazioni',
      },
      copySuffix: '(copia)',
      dragHandleAria: 'Trascina per riordinare',
    },
    chatPreferences: {
      title: 'Preferenze chat',
      includeCurrentFile: 'Includi file corrente',
      includeCurrentFileDesc:
        'Include automaticamente il file correntemente aperto nel contesto della chat.',
      enableTools: 'Abilita strumenti',
      enableToolsDesc:
        "Permetti all'AI di usare strumenti per cercare nel vault, eseguire calcoli, ecc.",
      maxAutoIterations: 'Iterazioni automatiche massime',
      maxAutoIterationsDesc:
        "Quante volte l'AI può chiamare automaticamente gli strumenti in una singola risposta.",
      maxContextMessages: 'Messaggi di contesto massimi',
      maxContextMessagesDesc:
        'Numero di messaggi precedenti da includere nel contesto della chat.',
    },
    assistants: {
      title: 'Assistenti',
      desc: 'Gestisci gli assistenti AI personalizzati con istruzioni e comportamenti specifici.',
      configureAssistants: 'Configura assistenti',
      assistantsCount: 'Assistenti configurati: {count}',
      addAssistant: 'Aggiungi assistente',
      noAssistants: 'Nessun assistente configurato',
      editAssistant: 'Modifica assistente',
      deleteAssistant: 'Elimina assistente',
      noAssistant: 'Nessun assistente',
      selectAssistant: 'Seleziona un assistente',
      name: 'Nome',
      nameDesc: "Nome dell'assistente",
      namePlaceholder: 'Ad esempio, Assistente di codifica',
      description: 'Descrizione',
      descriptionDesc: "Breve descrizione dello scopo dell'assistente",
      descriptionPlaceholder: 'Ad esempio, Aiuta con domande di programmazione',
      systemPrompt: 'Prompt di sistema',
      systemPromptDesc:
        "Istruzioni che definiscono il comportamento dell'assistente",
      systemPromptPlaceholder: 'Ad esempio, Sei un esperto programmatore...',
      defaultAssistantName: 'Nuovo assistente',
      actions: 'Azioni',
      deleteConfirmTitle: 'Elimina assistente',
      deleteConfirmMessagePrefix: 'Sei sicuro di voler eliminare',
      deleteConfirmMessageSuffix: '?',
      addAssistantAria: 'Aggiungi nuovo assistente',
      deleteAssistantAria: 'Elimina assistente',
      dragHandleAria: 'Trascina per riordinare',
      maxContextMessagesDesc:
        "Numero di messaggi precedenti da includere nel contesto (lascia vuoto per usare l'impostazione globale).",
      duplicate: 'Duplica',
      copySuffix: '(copia)',
      currentBadge: 'Corrente',
    },
    providers: {
      title: 'Provider',
      desc: 'Configura i provider di modelli AI e le loro chiavi API.',
      howToGetApiKeys: 'Come ottenere le chiavi API',
      addProvider: 'Aggiungi provider',
      editProvider: 'Modifica provider',
      editProviderTitle: 'Modifica provider',
      deleteProvider: 'Elimina provider',
      deleteConfirm: 'Sei sicuro di voler eliminare questo provider?',
      deleteWarning:
        'Questa azione rimuoverà anche tutti i modelli associati a questo provider.',
      chatModels: 'Modelli chat',
      embeddingModels: 'Modelli embedding',
      embeddingsWillBeDeleted:
        'Tutti gli embeddings esistenti saranno eliminati quando cambi il modello embedding.',
      addCustomProvider: 'Aggiungi provider personalizzato',
      providerId: 'ID provider',
      providerIdDesc:
        'Identificatore univoco per questo provider (ad es., openai, anthropic).',
      providerIdPlaceholder: 'Ad esempio, openai',
      apiKey: 'Chiave API',
      apiKeyDesc: 'La tua chiave API per questo provider.',
      apiKeyPlaceholder: 'Inserisci la tua chiave API',
      baseUrl: 'URL base',
      baseUrlDesc: 'URL endpoint API personalizzato (facoltativo).',
      baseUrlPlaceholder: 'Ad esempio, https://api.openai.com/v1',
      noStainlessHeaders: 'Nessun header stainless',
      noStainlessHeadersDesc:
        'Disabilita gli header SDK stainless (richiesto per alcuni provider compatibili).',
      useObsidianRequestUrl: 'Usa requestUrl di Obsidian',
      useObsidianRequestUrlDesc:
        'Usa requestUrl di Obsidian per aggirare le restrizioni CORS. Le risposte in streaming verranno bufferizzate.',
    },
    models: {
      title: 'Modelli',
      chatModels: 'Modelli chat',
      embeddingModels: 'Modelli embedding',
      addChatModel: 'Aggiungi modello chat',
      addEmbeddingModel: 'Aggiungi modello embedding',
      addCustomChatModel: 'Aggiungi modello chat personalizzato',
      addCustomEmbeddingModel: 'Aggiungi modello embedding personalizzato',
      editChatModel: 'Modifica modello chat',
      editEmbeddingModel: 'Modifica modello embedding',
      editCustomChatModel: 'Modifica modello chat personalizzato',
      editCustomEmbeddingModel: 'Modifica modello embedding personalizzato',
      modelId: 'ID modello',
      modelIdDesc:
        'Identificatore del modello usato dal provider (ad es., gpt-4, claude-3-opus).',
      modelIdPlaceholder: 'Ad esempio, gpt-4',
      modelName: 'Nome modello',
      modelNamePlaceholder: 'Ad esempio, GPT-4',
      availableModelsAuto: 'Modelli disponibili (recuperati automaticamente)',
      searchModels: 'Cerca modelli...',
      fetchModelsFailed: 'Impossibile recuperare i modelli',
      embeddingModelsFirst: 'Modelli embedding (prima)',
      reasoningType: 'Tipo di ragionamento',
      reasoningTypeNone: 'Nessuno',
      reasoningTypeOpenAI: 'OpenAI',
      reasoningTypeGemini: 'Gemini',
      reasoningTypeBase: 'Base',
      baseModelWarning:
        'I modelli base mostrano il processo di ragionamento completo nelle risposte. Non adatto per la maggior parte degli usi.',
      openaiReasoningEffort: 'Sforzo di ragionamento OpenAI',
      openaiReasoningEffortDesc:
        'Controlla quanto tempo il modello dedica al ragionamento (basso/medio/alto).',
      geminiThinkingBudget: 'Budget di pensiero Gemini',
      geminiThinkingBudgetDesc:
        'Tempo massimo di pensiero in millisecondi per richiesta.',
      geminiThinkingBudgetPlaceholder: 'Ad esempio, 10000',
      toolType: 'Tipo di strumento',
      toolTypeDesc:
        'Tipo di chiamata di strumento supportato da questo modello.',
      toolTypeNone: 'Nessuno',
      toolTypeGemini: 'Gemini',
      customParameters: 'Parametri personalizzati',
      customParametersDesc:
        'Parametri aggiuntivi da inviare al modello (formato JSON).',
      customParametersAdd: 'Aggiungi parametro',
      customParametersKeyPlaceholder: 'Chiave',
      customParametersValuePlaceholder: 'Valore',
      dimension: 'Dimensione',
      dimensionDesc: 'Dimensione del vettore embedding.',
      dimensionPlaceholder: 'Ad esempio, 1536',
      noChatModelsConfigured: 'Nessun modello chat configurato',
      noEmbeddingModelsConfigured: 'Nessun modello embedding configurato',
    },
    rag: {
      title: 'RAG (Retrieval Augmented Generation)',
      enableRag: 'Abilita RAG',
      enableRagDesc:
        "Permetti all'AI di cercare nel tuo vault note rilevanti per migliorare le risposte.",
      embeddingModel: 'Modello embedding',
      embeddingModelDesc:
        'Modello usato per generare embeddings per la ricerca semantica.',
      chunkSize: 'Dimensione chunk',
      chunkSizeDesc: 'Numero di caratteri per chunk di testo.',
      thresholdTokens: 'Token soglia',
      thresholdTokensDesc:
        'Attiva RAG quando il contesto della chat supera questo numero di token.',
      minSimilarity: 'Similarità minima',
      minSimilarityDesc:
        'Punteggio di similarità minimo (0-1) per includere un chunk nei risultati.',
      limit: 'Limite',
      limitDesc: 'Numero massimo di chunk da recuperare.',
      includePatterns: 'Pattern di inclusione',
      includePatternsDesc:
        "Pattern glob per i file da includere nell'indice (uno per riga).",
      excludePatterns: 'Pattern di esclusione',
      excludePatternsDesc:
        "Pattern glob per i file da escludere dall'indice (uno per riga).",
      testPatterns: 'Testa pattern',
      manageEmbeddingDatabase: 'Gestisci database embedding',
      manage: 'Gestisci',
      rebuildIndex: 'Ricostruisci indice',
      selectedFolders: 'Cartelle selezionate',
      excludedFolders: 'Cartelle escluse',
      selectFoldersPlaceholder: 'Seleziona cartelle...',
      selectFilesOrFoldersPlaceholder: 'Seleziona file o cartelle...',
      selectExcludeFoldersPlaceholder: 'Seleziona cartelle da escludere...',
      conflictNoteDefaultInclude: 'Nota: per default tutti i file sono inclusi',
      conflictExact:
        'Conflitto: questo percorso è sia incluso che escluso esplicitamente',
      conflictParentExclude:
        'Conflitto: una cartella genitore è esclusa, quindi questa inclusione è inefficace',
      conflictChildExclude:
        'Conflitto: cartelle figlio sono incluse, quindi questa esclusione è parzialmente inefficace',
      conflictRule: 'Regola di conflitto',
      autoUpdate: 'Aggiornamento automatico',
      autoUpdateDesc:
        "Aggiorna automaticamente l'indice quando i file vengono modificati.",
      autoUpdateInterval: 'Intervallo aggiornamento automatico',
      autoUpdateIntervalDesc:
        "Tempo di attesa (in millisecondi) dopo che un file viene modificato prima di aggiornare l'indice.",
      manualUpdateNow: 'Aggiorna ora',
      manualUpdateNowDesc:
        "Aggiorna manualmente l'indice per i file modificati dall'ultimo aggiornamento.",
      advanced: 'Impostazioni avanzate',
      indexProgressTitle: 'Progresso indicizzazione',
      indexing: 'Indicizzazione in corso...',
      notStarted: 'Non iniziato',
    },
    mcp: {
      title: 'MCP (Model Context Protocol)',
      desc: "Gestisci i server MCP che forniscono strumenti e risorse aggiuntive all'AI.",
      warning:
        'Avviso: i server MCP possono eseguire codice arbitrario. Aggiungi solo server di cui ti fidi.',
      notSupportedOnMobile: 'MCP non è supportato su mobile',
      mcpServers: 'Server MCP',
      addServer: 'Aggiungi server',
      serverName: 'Nome server',
      command: 'Comando',
      server: 'Server',
      status: 'Stato',
      enabled: 'Abilitato',
      actions: 'Azioni',
      noServersFound: 'Nessun server trovato',
      tools: 'Strumenti',
      error: 'Errore',
      connected: 'Connesso',
      connecting: 'Connessione in corso...',
      disconnected: 'Disconnesso',
      autoExecute: 'Esecuzione automatica',
      deleteServer: 'Elimina server',
      deleteServerConfirm: 'Sei sicuro di voler eliminare questo server?',
      edit: 'Modifica',
      delete: 'Elimina',
      expand: 'Espandi',
      collapse: 'Comprimi',
      validParameters: 'Parametri validi',
      failedToAddServer: 'Impossibile aggiungere il server',
      failedToDeleteServer: 'Impossibile eliminare il server',
    },
    templates: {
      title: 'Template',
      desc: 'Salva e riutilizza prompt e configurazioni comuni.',
      howToUse: 'Come usare',
      savedTemplates: 'Template salvati',
      addTemplate: 'Aggiungi template',
      templateName: 'Nome template',
      noTemplates: 'Nessun template salvato',
      loading: 'Caricamento...',
      deleteTemplate: 'Elimina template',
      deleteTemplateConfirm: 'Sei sicuro di voler eliminare questo template?',
      editTemplate: 'Modifica template',
      name: 'Nome',
      actions: 'Azioni',
    },
    continuation: {
      title: 'Continuazione',
      aiSubsectionTitle: 'Continuazione AI',
      customSubsectionTitle: 'Continuazione personalizzata',
      tabSubsectionTitle: 'Completamento Tab',
      superContinuation: 'Super continuazione',
      superContinuationDesc:
        'Abilita la vista Sparkle nella barra laterale per la configurazione avanzata della continuazione.',
      continuationModel: 'Modello di continuazione',
      continuationModelDesc:
        'Modello usato per generare testo di continuazione.',
      smartSpaceDescription:
        'Smart Space ti aiuta a continuare a scrivere con azioni rapide personalizzabili. Di default si apre con spazio su riga vuota o "/" + spazio; qui sotto puoi passare al doppio spazio o disattivare il trigger con spazio.',
      smartSpaceToggle: 'Abilita smart space',
      smartSpaceToggleDesc:
        'Mostra il menu smart space quando il cursore è su una riga vuota.',
      smartSpaceTriggerMode: 'Trigger spazio su riga vuota',
      smartSpaceTriggerModeDesc:
        'Cosa deve fare Smart Space quando premi spazio su una riga vuota.',
      smartSpaceTriggerModeSingle:
        'Spazio singolo per aprire (comportamento originale)',
      smartSpaceTriggerModeDouble:
        'Doppio spazio per aprire (~600ms; il primo spazio inserisce davvero uno spazio)',
      smartSpaceTriggerModeOff:
        'Disattiva trigger con spazio su riga vuota (solo "/" + spazio)',
      selectionChatToggle: 'Abilita chat selezione',
      selectionChatToggleDesc:
        'Mostra il menu contestuale quando selezioni il testo.',
      keywordTrigger: 'Trigger parola chiave',
      keywordTriggerDesc:
        'Trigger automaticamente la continuazione quando digiti una parola chiave specifica.',
      triggerKeyword: 'Parola chiave trigger',
      triggerKeywordDesc:
        'Parola chiave che trigger automaticamente la continuazione AI.',
      quickAskSubsectionTitle: 'Quick Ask',
      quickAskDescription:
        "Quick Ask è un menu contestuale che ti permette di chiedere all'AI o modificare il testo selezionato.",
      quickAskToggle: 'Abilita Quick Ask',
      quickAskToggleDesc:
        'Mostra il menu Quick Ask quando selezioni il testo e premi Cmd/Ctrl+Shift+K.',
      quickAskTrigger: 'Scorciatoia Quick Ask',
      quickAskTriggerDesc: 'Scorciatoia da tastiera per aprire Quick Ask.',
      tabCompletionBasicTitle: 'Impostazioni di base',
      tabCompletionBasicDesc:
        'Abilita il completamento tab e imposta i parametri principali.',
      tabCompletionTriggersSectionTitle: 'Impostazioni trigger',
      tabCompletionTriggersSectionDesc:
        'Configura quando deve attivarsi il completamento.',
      tabCompletionAutoSectionTitle: 'Impostazioni completamento automatico',
      tabCompletionAutoSectionDesc:
        'Regola il completamento dopo pausa e le opzioni avanzate.',
      tabCompletion: 'Completamento tab',
      tabCompletionDesc:
        'Genera suggerimenti quando una regola trigger corrisponde.',
      tabCompletionModel: 'Modello completamento tab',
      tabCompletionModelDesc:
        'Modello usato per generare suggerimenti di completamento tab.',
      tabCompletionTriggerDelay: 'Ritardo trigger (ms)',
      tabCompletionTriggerDelayDesc:
        'Quanto tempo attendere dopo che smetti di digitare prima di generare un suggerimento.',
      tabCompletionAutoTrigger: 'Completamento automatico dopo pausa',
      tabCompletionAutoTriggerDesc:
        'Attiva il completamento anche quando non ci sono trigger corrispondenti.',
      tabCompletionAutoTriggerDelay: 'Ritardo completamento automatico (ms)',
      tabCompletionAutoTriggerDelayDesc:
        'Quanto tempo attendere dopo la pausa prima di avviare il completamento automatico.',
      tabCompletionAutoTriggerCooldown:
        'Cooldown completamento automatico (ms)',
      tabCompletionAutoTriggerCooldownDesc:
        'Periodo di raffreddamento dopo il completamento automatico per evitare richieste frequenti.',
      tabCompletionMaxSuggestionLength: 'Lunghezza massima suggerimento',
      tabCompletionMaxSuggestionLengthDesc:
        'Numero massimo di caratteri da mostrare nel suggerimento.',
      tabCompletionLengthPreset: 'Lunghezza completamento',
      tabCompletionLengthPresetDesc:
        'Suggerisce al modello di generare un completamento breve, medio o lungo.',
      tabCompletionLengthPresetShort: 'Breve',
      tabCompletionLengthPresetMedium: 'Medio',
      tabCompletionLengthPresetLong: 'Lungo',
      tabCompletionAdvanced: 'Impostazioni avanzate',
      tabCompletionContextRange: 'Intervallo contesto',
      tabCompletionContextRangeDesc:
        'Caratteri totali di contesto inviati al modello (divisi 4:1 tra prima e dopo il cursore).',
      tabCompletionMinContextLength: 'Lunghezza minima contesto',
      tabCompletionMinContextLengthDesc:
        'Numero minimo di caratteri richiesti prima del cursore per attivare i suggerimenti.',
      tabCompletionTemperature: 'Temperatura',
      tabCompletionTemperatureDesc:
        'Controlla la casualità dei suggerimenti (0 = deterministico, 1 = creativo).',
      tabCompletionRequestTimeout: 'Timeout richiesta (ms)',
      tabCompletionRequestTimeoutDesc:
        'Quanto tempo attendere una risposta dal modello prima del timeout.',
      tabCompletionConstraints: 'Vincoli completamento tab',
      tabCompletionConstraintsDesc:
        'Regole opzionali inserite nel prompt di completamento tab (ad esempio "scrivi in italiano" o "segui uno stile specifico").',
      tabCompletionTriggersTitle: 'Trigger',
      tabCompletionTriggersDesc:
        'Il completamento tab si attiva solo quando una regola abilitata corrisponde.',
      tabCompletionTriggerAdd: 'Aggiungi trigger',
      tabCompletionTriggerEnabled: 'Abilitato',
      tabCompletionTriggerType: 'Tipo',
      tabCompletionTriggerTypeString: 'Stringa',
      tabCompletionTriggerTypeRegex: 'Regex',
      tabCompletionTriggerPattern: 'Pattern',
      tabCompletionTriggerDescription: 'Descrizione',
      tabCompletionTriggerRemove: 'Rimuovi',
    },
    etc: {
      title: 'Altro',
      resetSettings: 'Ripristina impostazioni',
      resetSettingsDesc:
        'Ripristina tutte le impostazioni ai valori predefiniti.',
      resetSettingsConfirm:
        'Sei sicuro di voler ripristinare tutte le impostazioni? Questa azione non può essere annullata.',
      resetSettingsSuccess: 'Impostazioni ripristinate con successo.',
      reset: 'Ripristina',
      clearChatHistory: 'Cancella cronologia chat',
      clearChatHistoryDesc: 'Elimina tutte le conversazioni chat salvate.',
      clearChatHistoryConfirm:
        'Sei sicuro di voler cancellare tutta la cronologia chat? Questa azione non può essere annullata.',
      clearChatHistorySuccess: 'Cronologia chat cancellata con successo.',
      resetProviders: 'Ripristina provider',
      resetProvidersDesc:
        'Ripristina tutte le configurazioni dei provider ai valori predefiniti.',
      resetProvidersConfirm:
        'Sei sicuro di voler ripristinare tutti i provider? Questa azione non può essere annullata.',
      resetProvidersSuccess: 'Provider ripristinati con successo.',
    },
  },

  chat: {
    placeholder: 'Scrivi un messaggio...',
    sendMessage: 'Invia messaggio',
    newChat: 'Nuova chat',
    continueResponse: 'Continua risposta',
    stopGeneration: 'Ferma generazione',
    vaultSearch: 'Cerca nel vault',
    selectModel: 'Seleziona modello',
    uploadImage: 'Carica immagine',
    addContext: 'Aggiungi contesto',
    applyChanges: 'Applica modifiche',
    copyMessage: 'Copia messaggio',
    regenerate: 'Rigenera',
    reasoning: 'Ragionamento',
    annotations: 'Annotazioni',
    codeBlock: {
      showRawText: 'Mostra testo grezzo',
      showFormattedText: 'Mostra testo formattato',
      copyText: 'Copia testo',
      textCopied: 'Testo copiato',
      apply: 'Applica',
      applying: 'Applicazione in corso...',
    },
    customContinuePromptLabel: 'Come vuoi continuare?',
    customContinuePromptPlaceholder: "Chiedi all'AI (@ per aggiungere i file)",
    customContinueHint:
      'Shift+Invio per inviare, Invio per nuova riga, Esc per chiudere',
    customContinueConfirmHint: 'Invia la tua istruzione per continuare',
    customRewritePromptPlaceholder:
      'Descrivi come riscrivere il testo selezionato, ad es. "rendi conciso e voce attiva; mantieni la struttura markdown"; premi shift+invio per confermare, invio per una nuova riga, ed esc per chiudere.',
    customContinueProcessing: 'Elaborazione...',
    customContinueError: 'Impossibile generare la continuazione',
    customContinuePresets: {
      continue: {
        label: 'Continua a scrivere',
        instruction: 'Continua il testo corrente nello stesso stile e tono.',
      },
      summarize: {
        label: 'Riassumi',
        instruction: 'Scrivi un riassunto conciso del contenuto corrente.',
      },
      flowchart: {
        label: 'Crea un diagramma di flusso',
        instruction:
          'Trasforma i punti correnti in un diagramma di flusso o passaggi ordinati.',
      },
    },
    customContinueSections: {
      suggestions: {
        title: 'Suggerimenti',
        items: {
          continue: {
            label: 'Continua a scrivere',
            instruction:
              'Continua il testo corrente nello stesso stile e tono.',
          },
        },
      },
      writing: {
        title: 'Scrittura',
        items: {
          summarize: {
            label: 'Aggiungi un riassunto',
            instruction: 'Scrivi un riassunto conciso del contenuto corrente.',
          },
          todo: {
            label: "Aggiungi elementi d'azione",
            instruction:
              'Genera una checklist di prossimi passi azionabili dal contesto corrente.',
          },
          flowchart: {
            label: 'Crea un diagramma di flusso',
            instruction:
              'Trasforma i punti correnti in un diagramma di flusso o passaggi ordinati.',
          },
          table: {
            label: 'Organizza in una tabella',
            instruction:
              'Converti le informazioni correnti in una tabella strutturata con colonne appropriate.',
          },
          freewrite: {
            label: 'Scrittura libera',
            instruction:
              'Inizia una nuova continuazione in uno stile creativo che si adatti al contesto.',
          },
        },
      },
      thinking: {
        title: 'Idea e conversa',
        items: {
          brainstorm: {
            label: 'Brainstorming idee',
            instruction:
              "Suggerisci diverse idee fresche o angolazioni basate sull'argomento corrente.",
          },
          analyze: {
            label: 'Analizza questa sezione',
            instruction:
              'Fornisci una breve analisi evidenziando intuizioni chiave, rischi o opportunità.',
          },
          dialogue: {
            label: 'Fai domande di approfondimento',
            instruction:
              "Genera domande ponderate che possono approfondire la comprensione dell'argomento.",
          },
        },
      },
      custom: {
        title: 'Personalizzato',
      },
    },
    showMore: 'Mostra altro',
    showLess: 'Mostra meno',
    conversationSettings: {
      openAria: 'Impostazioni conversazione',
      chatMemory: 'Memoria chat',
      maxContext: 'Contesto massimo',
      sampling: 'Parametri di campionamento',
      temperature: 'Temperatura',
      topP: 'Top p',
      streaming: 'Streaming',
      vaultSearch: 'Cerca nel vault',
      useVaultSearch: 'Ricerca RAG',
      geminiTools: 'Strumenti Gemini',
      webSearch: 'Ricerca web',
      urlContext: 'Contesto URL',
    },
  },

  notices: {
    rebuildingIndex: 'Ricostruzione indice vault in corso…',
    rebuildComplete: 'Ricostruzione indice vault completata.',
    rebuildFailed: 'Ricostruzione indice vault fallita.',
    pgliteUnavailable: 'Risorse PGlite non disponibili; reinstalla il plugin.',
    downloadingPglite:
      'Download dipendenze PGlite da CDN (~20MB); potrebbe richiedere un momento…',
    updatingIndex: 'Aggiornamento indice vault in corso…',
    indexUpdated: 'Indice vault aggiornato.',
    indexUpdateFailed: 'Aggiornamento indice vault fallito.',
    migrationComplete: 'Migrazione a storage JSON completata con successo.',
    migrationFailed:
      'Migrazione a storage JSON fallita; controlla la console per i dettagli.',
    reloadingPlugin: 'Ricaricamento "next-composer" a causa della migrazione',
    settingsInvalid: 'Impostazioni non valide',
  },

  errors: {
    providerNotFound: 'Provider non trovato',
    modelNotFound: 'Modello non trovato',
    invalidApiKey: 'Chiave API non valida',
    networkError: 'Errore di rete',
    databaseError: 'Errore database',
    mcpServerError: 'Errore server',
  },

  applyView: {
    applying: 'Applicazione',
    changesResolved: 'modifiche risolte',
    acceptAllIncoming: 'Accetta tutte in arrivo',
    rejectAll: 'Rifiuta tutte',
    reset: 'Ripristina',
    applyAndClose: 'Applica e chiudi',
    acceptIncoming: 'Accetta in arrivo',
    acceptCurrent: 'Accetta corrente',
    acceptBoth: 'Accetta entrambe',
    acceptedIncoming: 'In arrivo accettata',
    keptCurrent: 'Corrente mantenuta',
    mergedBoth: 'Entrambe unite',
    undo: 'Annulla',
  },

  quickAsk: {
    selectAssistant: 'Seleziona un assistente',
    noAssistant: 'Nessun assistente',
    noAssistantDescription: 'Usa prompt di sistema predefinito',
    navigationHint: '↑↓ per navigare, Invio per selezionare, Esc per annullare',
    inputPlaceholder: 'Fai una domanda...',
    close: 'Chiudi',
    copy: 'Copia',
    insert: 'Inserisci',
    openInSidebar: 'Apri nella barra laterale',
    stop: 'Ferma',
    send: 'Invia',
    clear: 'Cancella conversazione',
    clearConfirm: 'Sei sicuro di voler cancellare la conversazione corrente?',
    cleared: 'Conversazione cancellata',
    error: 'Impossibile generare la risposta',
    copied: 'Copiato negli appunti',
    inserted: 'Inserito al cursore',
    modeAsk: 'Chiedi',
    modeEdit: 'Modifica',
    modeEditDirect: 'Modifica (Accesso completo)',
    modeAskDesc: 'Fai domande e ottieni risposte',
    modeEditDesc: 'Modifica il documento corrente',
    modeEditDirectDesc: 'Modifica il documento direttamente senza conferma',
    editNoFile: 'Apri prima un file',
    editNoChanges: 'Nessuna modifica valida restituita dal modello',
    editPartialSuccess:
      'Applicate ${appliedCount} di ${blocks.length} modifiche. Controlla la console per i dettagli.',
    editApplied:
      'Applicate con successo ${appliedCount} modifica/modifiche a ${activeFile.name}',
  },

  chatMode: {
    chat: 'Chat',
    chatDesc: 'Modalità conversazione normale',
    agent: 'Agent',
    agentDesc: 'Abilita le capacità di chiamata degli strumenti',
  },

  reasoning: {
    selectReasoning: 'Seleziona ragionamento',
    off: 'Disattivato',
    low: 'Basso',
    medium: 'Medio',
    high: 'Alto',
    extraHigh: 'Extra alto',
  },
}
