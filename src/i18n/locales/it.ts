import type { TranslationKeys } from '../types'

export const it: TranslationKeys = {
  commands: {
    openChat: 'Apri chat',
    openChatSidebar: 'Apri chat (barra laterale)',
    newChatCurrentView: 'Nuova chat',
    openYoloNewChat: 'YOLO: Apri finestra chat',
    openNewChatTab: 'Apri nuova chat (nuova scheda)',
    openNewChatSplit: 'Apri nuova chat (divisione destra)',
    openNewChatWindow: 'Apri nuova chat (nuova finestra)',
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
    characters: 'caratteri',
    words: 'parole',
    wordsCharacters: 'parole/caratteri',
    default: 'Predefinito',
    modelDefault: 'Predefinito del modello',
    on: 'Attivo',
    off: 'Disattivo',
    noResults: 'Nessuna corrispondenza trovata',
  },

  sidebar: {
    tabs: {
      chat: 'Chat',
      agent: 'Agent',
      composer: 'Sparkle',
    },
    chatList: {
      searchPlaceholder: 'Cerca conversazioni',
      empty: 'Nessuna conversazione',
      retryTitle: 'Riprova titolo',
      archived: 'Archiviate',
      hideArchived: 'Nascondi archiviate',
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
      addToSidebar: 'Aggiungi alla barra laterale',
      customRewrite: 'Riscrittura personalizzata',
      customAsk: 'Domanda personalizzata',
      rewrite: 'AI riscrivi',
      explain: 'Spiega in dettaglio',
      suggest: 'Fornisci suggerimenti',
      translateToChinese: 'Traduci in cinese',
    },
  },

  settings: {
    title: 'Impostazioni Yolo',
    tabs: {
      models: 'Modelli',
      editor: 'Editor',
      knowledge: 'Conoscenza',
      tools: 'Strumenti',
      agent: 'Agent',
      others: 'Altro',
    },
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
        "Questo prompt viene aggiunto all'inizio di ogni conversazione chat. Variabili supportate: data {{current_date}}, data + ora corrente {{current_hour}}, data + ora e minuti correnti {{current_minute}}.",
      continuationSystemPrompt:
        'Prompt di sistema di continuazione predefinito',
      continuationSystemPromptDesc:
        'Usato come messaggio di sistema quando si genera testo di continuazione; lascia vuoto per usare quello predefinito incorporato.',
      chatTitlePrompt: 'Prompt titolo chat',
      chatTitlePromptDesc:
        'Prompt usato quando si generano automaticamente i titoli delle conversazioni dal primo messaggio utente.',
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
      resetConfirmTitle: 'Ripristina azioni rapide smart space',
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
    selectionChat: {
      quickActionsTitle: 'Comandi Cursor',
      quickActionsDesc:
        'Personalizza i comandi e i prompt visualizzati dopo la selezione del testo',
      configureActions: 'Configura comandi',
      actionsCount: 'Comandi configurati: {count}',
      addAction: 'Aggiungi comando',
      resetToDefault: 'Ripristina predefiniti',
      confirmReset:
        'Sei sicuro di voler ripristinare i comandi predefiniti ed eliminare tutte le impostazioni personalizzate?',
      resetConfirmTitle: 'Ripristina comandi Cursor',
      actionLabel: 'Etichetta comando',
      actionLabelDesc: 'Testo visualizzato nel comando',
      actionLabelPlaceholder: 'Ad esempio, spiega',
      actionMode: 'Modalita',
      actionModeDesc:
        'Ask apre Quick Ask e invia automaticamente; Aggiungi alla chat apre la chat laterale e precompila la casella di input; rewrite apre la modalita di modifica di Quick Ask per generare un anteprima.',
      actionModeAsk: 'Ask (Quick Ask)',
      actionModeChatInput: 'Aggiungi alla chat',
      actionModeRewrite: 'Rewrite (anteprima)',
      actionRewriteType: 'Tipo di riscrittura',
      actionRewriteTypeDesc: 'Scegli se la riscrittura richiede un prompt',
      actionRewriteTypeCustom: 'Prompt personalizzato (chiedi ogni volta)',
      actionRewriteTypePreset: 'Prompt predefinito (esegui subito)',
      actionInstruction: 'Prompt',
      actionInstructionDesc: "Istruzione inviata all'AI",
      actionInstructionPlaceholder:
        'Ad esempio, spiega il contenuto selezionato.',
      actionInstructionRewriteDesc:
        'Istruzione di riscrittura (richiesta per il prompt predefinito).',
      actionInstructionRewritePlaceholder:
        'Ad esempio: rendilo conciso e mantieni la struttura Markdown.',
      duplicate: 'Duplica',
      copySuffix: '(copia)',
      dragHandleAria: 'Trascina per riordinare',
    },
    chatPreferences: {
      title: 'Preferenze chat',
      includeCurrentFile: 'Includi file corrente',
      includeCurrentFileDesc:
        'Include automaticamente il file correntemente aperto nel contesto della chat.',
      historyArchiveEnabled: 'Abilita raggruppamento archivio cronologia',
      historyArchiveEnabledDesc:
        'Mantiene le conversazioni non appuntate meno recenti compresse in una sezione archivio.',
      historyArchiveThreshold: 'Limite conversazioni recenti',
      historyArchiveThresholdDesc:
        'Numero di conversazioni non appuntate recenti da mostrare prima di archiviare le altre (20-500).',
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
        "Questo prompt viene aggiunto all'inizio di ogni chat. Variabili supportate: data {{current_date}}, data + ora corrente {{current_hour}}, data + ora e minuti correnti {{current_minute}}.",
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
    agent: {
      title: 'Agent',
      desc: 'Gestisci le capacità globali e configura i tuoi agenti.',
      globalCapabilities: 'Capacità globali',
      mcpServerCount: '{count} server strumenti personalizzati (MCP) connessi',
      tools: 'Strumenti',
      toolsCount: '{count} strumenti',
      toolsCountWithEnabled: '{count} strumenti (abilitati {enabled})',
      skills: 'Competenze',
      skillsCount: '{count} competenze',
      skillsCountWithEnabled: '{count} competenze (abilitate {enabled})',
      skillsGlobalDesc:
        'Le skill vengono rilevate dalle skill integrate e da {path}/**/*.md (escludendo Skills.md quando applicabile). Disabilitale qui per bloccarle su tutti gli agent.',
      yoloBaseDir: 'Cartella base YOLO',
      yoloBaseDirDesc:
        'Inserisci un percorso relativo al vault (senza / iniziale). Esempio: YOLO nella radice del vault, oppure setting/YOLO nella cartella setting.',
      yoloBaseDirPlaceholder: 'YOLO',
      skillsSourcePath:
        'Origine: skill integrate + {path}/*.md + {path}/**/SKILL.md',
      refreshSkills: 'Aggiorna',
      skillsEmptyHint:
        'Nessuna skill trovata. Crea file markdown skill sotto {path}.',
      createSkillTemplates: 'Inizializza sistema Skills',
      skillsTemplateCreated: 'Sistema Skills inizializzato in {path}.',
      agents: 'Agent',
      agentsDesc:
        'Clicca Configura per modificare il profilo e il prompt di ciascun agent.',
      configureAgents: 'Configura',
      noAgents: 'Nessun agent configurato',
      newAgent: 'Nuovo agent',
      current: 'Corrente',
      duplicate: 'Duplica',
      copySuffix: '(copia)',
      deleteConfirmTitle: 'Conferma eliminazione agent',
      deleteConfirmMessagePrefix: 'Sei sicuro di voler eliminare agent',
      deleteConfirmMessageSuffix: '? Questa azione non può essere annullata.',
      toolSourceBuiltin: 'Integrato',
      toolSourceMcp: 'MCP',
      noMcpTools: 'Nessuno strumento personalizzato (MCP) rilevato',
      toolsEnabledCount: '{count} abilitati',
      manageTools: 'Gestisci strumenti',
      manageSkills: 'Gestisci competenze',
      descriptionColumn: 'Descrizione',
      builtinFsListLabel: 'Leggi vault',
      builtinFsListDesc:
        'Elenca la struttura delle directory del vault per orientarsi rapidamente.',
      builtinFsSearchLabel: 'Cerca nel vault',
      builtinFsSearchDesc:
        'Cerca file, cartelle o contenuti Markdown nel vault.',
      builtinFsReadLabel: 'Leggi file',
      builtinFsReadDesc:
        'Legge intervalli di righe da uno o più file del vault.',
      builtinFsEditLabel: 'Modifica testo',
      builtinFsEditDesc:
        'Applica operazioni di modifica del testo in un singolo file esistente, incluse replace, insert_after e append.',
      safetyControls: 'Controlli di sicurezza',
      safetyControlsDesc:
        'Configura una revisione aggiuntiva prima che gli agent eseguano operazioni rischiose sui file.',
      fsEditReviewToggle: 'Richiedi approvazione prima di modificare i file',
      fsEditReviewToggleDesc:
        "Se abilitato, le modifiche fs_edit dell'agent aprono la revisione inline/apply prima di scrivere il file.",
      builtinFsFileOpsLabel: 'Set operazioni file',
      builtinFsFileOpsDesc:
        'Operazioni percorso file raggruppate: crea/elimina file, crea/elimina cartelle e sposta.',
      builtinMemoryOpsLabel: 'Set strumenti memoria',
      builtinMemoryOpsDesc:
        'Operazioni memoria raggruppate: aggiungi, aggiorna ed elimina memoria.',
      builtinMemoryAddLabel: 'Aggiungi memoria',
      builtinMemoryAddDesc:
        "Aggiunge una memoria globale o dell'assistant con id assegnato automaticamente.",
      builtinMemoryUpdateLabel: 'Aggiorna memoria',
      builtinMemoryUpdateDesc: 'Aggiorna una memoria esistente tramite id.',
      builtinMemoryDeleteLabel: 'Elimina memoria',
      builtinMemoryDeleteDesc: 'Elimina una memoria esistente tramite id.',
      builtinOpenSkillLabel: 'Apri skill',
      builtinOpenSkillDesc: 'Carica un file markdown skill tramite id o nome.',
      editorDefaultName: 'Nuovo agent',
      editorIntro:
        'Configura le capacità, il modello e il comportamento di questo agent.',
      editorTabProfile: 'Profilo',
      editorTabTools: 'Strumenti',
      editorTabSkills: 'Competenze',
      editorTabModel: 'Modello',
      editorName: 'Nome',
      editorNameDesc: "Nome visualizzato dell'agent",
      editorDescription: 'Descrizione',
      editorDescriptionDesc: 'Breve descrizione di questo agent',
      editorIcon: 'Icona',
      editorIconDesc: "Scegli un'icona per questo agent",
      editorChooseIcon: 'Scegli icona',
      editorSystemPrompt: 'System prompt',
      editorSystemPromptDesc:
        'Istruzione comportamentale principale per questo agent. Variabili supportate: data {{current_date}}, data + ora corrente {{current_hour}}, data + ora e minuti correnti {{current_minute}}.',
      editorEnableTools: 'Abilita strumenti',
      editorEnableToolsDesc: 'Consenti a questo agent di chiamare strumenti',
      editorIncludeBuiltinTools: 'Includi strumenti integrati',
      editorIncludeBuiltinToolsDesc:
        'Consenti strumenti file locali del vault per questo agent',
      editorEnabled: 'Abilitato',
      editorDisabled: 'Disabilitato',
      editorModel: 'Modello',
      editorModelCurrent: 'Corrente: {model}',
      editorTemperature: 'Temperatura',
      editorTemperatureDesc: '0.0 - 2.0',
      editorTopP: 'Top P',
      editorTopPDesc: '0.0 - 1.0',
      editorMaxOutputTokens: 'Token massimi in output',
      editorMaxOutputTokensDesc: 'Numero massimo di token generati',
      editorToolsCount: '{count} strumenti',
      editorSkillsCount: '{count} competenze',
      editorSkillsCountWithEnabled: '{count} competenze (abilitate {enabled})',
      skillLoadAlways: 'Iniezione completa',
      skillLoadLazy: 'Su richiesta',
      skillDisabledGlobally: 'Disabilitata globalmente',
    },
    providers: {
      title: 'Provider',
      desc: 'Configura i provider di modelli AI e le loro chiavi API.',
      howToGetApiKeys: 'Come ottenere le chiavi API',
      addProvider: 'Aggiungi provider',
      providersCount: '{count} provider aggiunti',
      editProvider: 'Modifica provider',
      editProviderTitle: 'Modifica provider',
      deleteProvider: 'Elimina provider',
      deleteConfirm: 'Sei sicuro di voler eliminare questo provider?',
      deleteWarning:
        'Questa azione rimuoverà anche tutti i modelli associati a questo provider.',
      requestDelete: 'Elimina provider',
      deleteConfirmTitle: 'Eliminare il provider "{provider}"?',
      deleteConfirmImpact:
        'Questa azione rimuove anche {chatCount} modelli chat, {embeddingCount} modelli embedding e i relativi dati vettoriali.',
      confirmDeleteAction: 'Conferma eliminazione',
      chatModels: 'chat',
      embeddingModels: 'embedding',
      embeddingsWillBeDeleted:
        'Tutti gli embeddings esistenti saranno eliminati quando cambi il modello embedding.',
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
      requestTransportMode: 'Modalita trasporto richieste',
      requestTransportModeDesc:
        'Auto prova prima il fetch del browser e passa a requestUrl di Obsidian in caso di errori CORS/rete. In modalita Obsidian lo streaming viene bufferizzato.',
      requestTransportModeAuto: 'Auto (consigliato)',
      requestTransportModeBrowser: 'Solo fetch browser',
      requestTransportModeObsidian: 'Solo requestUrl Obsidian',
      customHeaders: 'Header personalizzati',
      customHeadersDesc:
        'Aggiungi header HTTP extra a tutte le richieste inviate tramite questo provider.',
      customHeadersAdd: 'Aggiungi header',
      customHeadersKeyPlaceholder: 'Nome header',
      customHeadersValuePlaceholder: 'Valore header',
      chatgptOAuthTitle: 'ChatGPT OAuth',
      chatgptOAuthConnect: 'Connetti',
      chatgptOAuthDisconnect: 'Disconnetti',
      chatgptOAuthConnecting: 'Connessione in corso...',
      chatgptOAuthLoadingStatus: 'Caricamento stato ChatGPT OAuth...',
      chatgptOAuthConnected: 'Connesso',
      chatgptOAuthExpires: 'scade',
      chatgptOAuthDisconnectedHelp:
        'Non connesso. Connettiti per usare i modelli del tuo account ChatGPT Plus / Pro.',
      chatgptOAuthStreamingNotice:
        'A causa delle limitazioni dell ambiente Obsidian, ChatGPT OAuth al momento non supporta le risposte in streaming.',
      chatgptOAuthPendingCode: 'Codice dispositivo corrente:',
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
      reasoningTypeNone: 'Modello non ragionante / predefinito',
      reasoningTypeOpenAI: 'OpenAI',
      reasoningTypeGemini: 'Gemini',
      reasoningTypeAnthropic: 'Claude Extended Thinking',
      reasoningTypeGeneric: 'Modello di ragionamento generico',
      openaiReasoningEffort: 'Sforzo di ragionamento OpenAI',
      openaiReasoningEffortDesc:
        'Controlla quanto tempo il modello dedica al ragionamento (basso/medio/alto).',
      geminiThinkingBudget: 'Budget di pensiero Gemini',
      geminiThinkingBudgetDesc:
        'Unità: token di thinking. 0 = off; -1 = dinamico (solo Gemini).',
      geminiThinkingBudgetPlaceholder: 'Ad esempio, 10000',
      toolType: 'Tipo di strumento',
      toolTypeDesc:
        'Tipo di chiamata di strumento supportato da questo modello.',
      toolTypeNone: 'Nessuno',
      toolTypeGemini: 'Gemini',
      toolTypeGpt: 'Strumenti GPT',
      gptTools: 'Strumenti GPT',
      gptToolsDesc:
        'Scegli gli strumenti GPT integrati disponibili per questo modello.',
      gptToolWebSearch: 'Web Search',
      gptToolWebSearchDesc:
        'Consenti al modello di cercare sul web e restituire fonti citate.',
      sampling: 'Parametri di campionamento',
      restoreDefaults: 'Ripristina predefiniti',
      maxOutputTokens: 'Token massimi in output',
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
      title: 'Strumenti personalizzati (MCP)',
      desc: 'Gestisci i server MCP per configurare le capacità degli strumenti personalizzati.',
      warning:
        'Avviso: i server MCP possono eseguire codice arbitrario. Aggiungi solo server di cui ti fidi.',
      notSupportedOnMobile:
        'Gli strumenti personalizzati (MCP) non sono supportati su mobile',
      mcpServers: 'Server MCP',
      addServer: 'Aggiungi server strumenti personalizzati (MCP)',
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
      deleteServer: 'Elimina server strumenti personalizzati',
      deleteServerConfirm:
        'Sei sicuro di voler eliminare questo server di strumenti personalizzati?',
      edit: 'Modifica',
      delete: 'Elimina',
      expand: 'Espandi',
      collapse: 'Comprimi',
      addServerTitle: 'Aggiungi server',
      editServerTitle: 'Modifica server',
      serverNameField: 'Nome',
      serverNameFieldDesc: 'Il nome del server MCP',
      serverNamePlaceholder: "es. 'github'",
      parametersField: 'Parametri',
      parametersFieldDesc:
        'Configurazione JSON del trasporto MCP. Formati supportati:\n- stdio: {"transport":"stdio","command":"npx","args":[...],"env":{...}}\n- http: {"transport":"http","url":"https://...","headers":{...}}\n- sse: {"transport":"sse","url":"https://...","headers":{...}}\n- ws: {"transport":"ws","url":"wss://..."}\nSono supportati anche i wrapper: {"mcpServers": {"name": {...}}} e {"id":"name","parameters": {...}}',
      parametersFieldDescShort:
        'Configurazione JSON per il server MCP. Supporta i trasporti stdio, http, sse, ws.',
      parametersFormatHelp: 'Guida al formato',
      parametersTooltipDesc:
        'Formato consigliato:\n- stdio: {"transport":"stdio","command":"npx",...}\n- http/sse/ws: {"transport":"http|sse|ws","url":"..."}\n\nWrapper compatibili:\n- {"mcpServers": {"name": {...}}}\n- {"id":"name","parameters": {...}}\n\nSuggerimento: se mcpServers contiene un solo server, il nome viene compilato automaticamente.',
      parametersTooltipTitle: 'Esempi formato',
      parametersTooltipPreferred: 'Consigliato',
      parametersTooltipCompatible: 'Compatibile',
      parametersTooltipTip:
        'Suggerimento: se mcpServers contiene un solo server, il nome viene compilato automaticamente.',
      serverNameRequired: 'Il nome e obbligatorio',
      serverAlreadyExists: 'Esiste gia un server con lo stesso nome',
      parametersRequired: 'I parametri sono obbligatori',
      parametersMustBeValidJson: 'I parametri devono essere JSON valido',
      invalidJsonFormat: 'Formato JSON non valido',
      invalidParameters: 'Parametri non validi',
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
      selectionChatSubsectionTitle: 'Cursor chat',
      selectionChatDescription:
        'Cursor chat aggiunge un menu azioni sulla selezione (riscrivi/spiega) e mantiene la selezione sincronizzata con la chat laterale.',
      selectionChatToggle: 'Abilita chat selezione',
      selectionChatToggleDesc:
        "Mostra l'indicatore e il menu azioni (riscrivi/spiega). La selezione continua a sincronizzarsi con la chat laterale.",
      selectionChatAutoDock: 'Dock automatico in alto a destra',
      selectionChatAutoDockDesc:
        "Dopo l'invio, sposta in alto a destra (il trascinamento manuale disattiva il follow).",
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
      quickAskContextBeforeChars: 'Contesto prima del cursore (caratteri)',
      quickAskContextBeforeCharsDesc:
        'Numero massimo di caratteri prima del cursore da includere (predefinito: 5000).',
      quickAskContextAfterChars: 'Contesto dopo il cursore (caratteri)',
      quickAskContextAfterCharsDesc:
        'Numero massimo di caratteri dopo il cursore da includere (predefinito: 2000).',
      tabCompletionBasicTitle: 'Impostazioni di base',
      tabCompletionBasicDesc:
        'Abilita il completamento tab e imposta i parametri principali.',
      tabCompletionTriggersSectionTitle: 'Impostazioni trigger',
      tabCompletionTriggersSectionDesc:
        'Configura quando deve attivarsi il completamento.',
      tabCompletionAutoSectionTitle: 'Impostazioni completamento automatico',
      tabCompletionAutoSectionDesc: 'Regola il completamento dopo pausa.',
      tabCompletionAdvancedSectionDesc:
        'Configura le opzioni avanzate del completamento tab.',
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
      clearChatSnapshots: 'Cancella snapshot chat',
      clearChatSnapshotsDesc:
        'Elimina tutti i file snapshot di contesto delle conversazioni (senza eliminare i messaggi chat).',
      clearChatSnapshotsConfirm:
        'Sei sicuro di voler cancellare tutti i file snapshot della chat? Questa azione non può essere annullata e il contesto potrebbe dover essere ricostruito in seguito.',
      clearChatSnapshotsSuccess:
        'Tutti i file snapshot della chat sono stati cancellati.',
      resetProviders: 'Ripristina provider',
      resetProvidersDesc:
        'Ripristina tutte le configurazioni dei provider ai valori predefiniti.',
      resetProvidersConfirm:
        'Sei sicuro di voler ripristinare tutti i provider? Questa azione non può essere annullata.',
      resetProvidersSuccess: 'Provider ripristinati con successo.',
      resetAgents: 'Ripristina agent',
      resetAgentsDesc:
        'Ripristina la configurazione predefinita degli agent e rimuove gli agent personalizzati.',
      resetAgentsConfirm:
        'Sei sicuro di voler ripristinare la configurazione degli agent? Questa azione rimuoverà gli agent personalizzati e reimposterà la selezione corrente.',
      resetAgentsSuccess:
        'La configurazione degli agent è stata ripristinata ai valori predefiniti.',
      yoloBaseDir: 'Cartella base YOLO',
      yoloBaseDirDesc:
        'Inserisci un percorso relativo al vault (senza / iniziale). Esempio: YOLO nella radice del vault, oppure setting/YOLO nella cartella setting. Directory skill attuale: {path}.',
      yoloBaseDirPlaceholder: 'YOLO',
      mentionDisplayMode: 'Posizione visualizzazione mention',
      mentionDisplayModeDesc:
        "Scegli se mostrare i file selezionati con @ e le skill selezionate con / nel testo dell'input o come badge sopra la casella.",
      mentionDisplayModeInline: 'Dentro la casella',
      mentionDisplayModeBadge: 'Badge in alto',
      persistSelectionHighlight: 'Mantieni evidenziazione blocco selezione',
      persistSelectionHighlightDesc:
        "Mantiene visibile l'evidenziazione a blocco del contenuto selezionato nell'editor durante l'interazione con la Chat laterale o Quick Ask.",
      notifications: 'Notifiche',
      notificationsDesc:
        "Configura gli avvisi per Agent. Le notifiche di sistema degradano automaticamente se l'ambiente non le supporta.",
      notificationsEnabled: 'Abilita notifiche',
      notificationsEnabledDesc:
        'Attiva o disattiva gli avvisi per le esecuzioni Agent.',
      notificationChannel: 'Metodo di notifica',
      notificationChannelDesc:
        'Scegli se usare suono, notifiche di sistema o entrambe.',
      notificationChannelSound: 'Solo suono',
      notificationChannelSystem: 'Solo sistema',
      notificationChannelBoth: 'Suono + sistema',
      notificationApprovalRequired: "Notifica quando serve l'approvazione",
      notificationApprovalRequiredDesc:
        "Avvisa quando YOLO si ferma e richiede l'approvazione per una chiamata strumento.",
      notificationTaskCompleted: 'Notifica al termine del task',
      notificationTaskCompletedDesc:
        "Avvisa quando l'esecuzione corrente di Agent termina senza attendere ulteriori approvazioni.",
    },
  },

  chat: {
    placeholder:
      'Scrivi un messaggio...「@ per aggiungere riferimenti, / per scegliere una skill」',
    placeholderCompact: 'Clicca per espandere e modificare...',
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
    insertAtCursor: 'Inserisci / Sostituisci al cursore',
    insertSuccess: 'Messaggio inserito nella nota attiva',
    insertUnavailable: 'Nessun editor markdown attivo trovato',
    noAssistantContent: 'Nessun contenuto assistente da inserire',
    regenerate: 'Rigenera',
    reasoning: 'Ragionamento',
    annotations: 'Annotazioni',
    mentionMenu: {
      back: 'Torna indietro',
      entryCurrentFile: 'File corrente',
      entryMode: 'Modalita',
      entrySkill: 'Skill',
      entryAssistant: 'Assistente',
      entryFile: 'File',
      entryFolder: 'Cartella',
    },
    emptyState: {
      chatTitle: 'Pensa prima, poi scrivi',
      chatDescription:
        "Ideale per domande, revisione e riscrittura, con focus sull'espressione.",
      agentTitle: "Lascia eseguire all'AI",
      agentDescription:
        'Abilita gli strumenti per ricerca, lettura/scrittura e task multi-step.',
    },
    codeBlock: {
      showRawText: 'Mostra testo grezzo',
      showFormattedText: 'Mostra testo formattato',
      copyText: 'Copia testo',
      textCopied: 'Testo copiato',
      apply: 'Applica',
      applying: 'Applicazione in corso...',
      locatingTarget:
        'Individuazione e caricamento del contenuto sostitutivo...',
      emptyPlanPreview: 'Questo piano rimuove contenuto',
      stopApplying: 'Interrompi applicazione',
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
    toolCall: {
      status: {
        call: 'Chiama',
        rejected: 'Rifiutato',
        running: 'In esecuzione',
        failed: 'Fallito',
        aborted: 'Interrotto',
        unknown: 'Sconosciuto',
      },
      displayName: {
        fs_list: 'Elenca file',
        fs_search: 'Cerca file',
        fs_read: 'Leggi file',
        fs_edit: 'Modifica testo',
        fs_file_ops: 'Set operazioni file',
        memory_add: 'Aggiungi memoria',
        memory_update: 'Aggiorna memoria',
        memory_delete: 'Elimina memoria',
        open_skill: 'Apri skill',
      },
      writeAction: {
        create_file: 'Crea file',
        delete_file: 'Elimina file',
        create_dir: 'Crea cartella',
        delete_dir: 'Elimina cartella',
        move: 'Sposta percorso',
      },
      detail: {
        target: 'Destinazione',
        scope: 'Ambito',
        query: 'Query',
        path: 'Percorso',
        paths: 'percorsi',
      },
      parameters: 'Parametri',
      noParameters: 'Nessun parametro',
      result: 'Risultato',
      error: 'Errore',
      allow: 'Consenti',
      reject: 'Rifiuta',
      abort: 'Interrompi',
      alwaysAllowThisTool: 'Consenti sempre questo strumento',
      allowForThisChat: 'Consenti per questa chat',
    },
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
    notification: {
      approvalTitle: 'YOLO richiede la tua conferma',
      approvalBody:
        "Il task corrente è in pausa e attende la tua approvazione per una chiamata strumento.",
      completedTitle: 'Task YOLO terminato',
      completedBody:
        "L'esecuzione corrente di Agent è terminata. Puoi tornare a controllare il risultato.",
      completedErrorBody:
        "L'esecuzione corrente di Agent è terminata. Torna alla finestra per controllare il risultato.",
    },
  },

  notices: {
    rebuildingIndex: 'Ricostruzione indice vault in corso…',
    rebuildComplete: 'Ricostruzione indice vault completata.',
    rebuildFailed: 'Ricostruzione indice vault fallita.',
    openYoloNewChatFailed:
      'Impossibile aprire la finestra chat YOLO; prova prima dal palette comandi.',
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
    transportModeAutoPromoted:
      'Rilevato un problema di rete/CORS. Questo provider e stato impostato automaticamente su Obsidian requestUrl.',
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
    prevChange: 'Modifica precedente',
    nextChange: 'Modifica successiva',
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
      'Applicate {appliedCount} di {totalEdits} modifiche. Controlla la console per i dettagli.',
    editApplied:
      'Applicate con successo {appliedCount} modifica/modifiche a {fileName}',
    statusRequesting: 'Richiesta in corso...',
    statusThinking: 'Sto pensando...',
    statusGenerating: 'Sto generando...',
    statusModifying: 'Sto modificando...',
  },

  chatMode: {
    chat: 'Chat',
    chatDesc: 'Chiedi, rifinisci, crea',
    rewrite: 'Riscrivi',
    rewriteDesc: 'Modifica solo la selezione corrente',
    agent: 'Agent',
    agentDesc: 'Strumenti per task complessi',
    warning: {
      title: 'Conferma prima di abilitare la modalita Agent',
      description:
        "L'Agent puo invocare strumenti automaticamente. Prima di continuare, leggi i seguenti rischi:",
      permission:
        'Controlla rigorosamente i permessi di chiamata degli strumenti e concedi solo quelli necessari.',
      cost: "Le attivita dell'Agent possono consumare molte risorse del modello e comportare costi piu elevati.",
      backup:
        'Esegui un backup dei contenuti importanti in anticipo per evitare modifiche indesiderate.',
      checkbox:
        'Ho compreso i rischi sopra indicati e accetto la responsabilita di procedere',
      cancel: 'Annulla',
      confirm: 'Continua e abilita Agent',
    },
  },

  reasoning: {
    selectReasoning: 'Seleziona ragionamento',
    off: 'Disattivato',
    on: 'Attivato',
    auto: 'Auto',
    low: 'Basso',
    medium: 'Medio',
    high: 'Alto',
    extraHigh: 'Extra alto',
  },
}
