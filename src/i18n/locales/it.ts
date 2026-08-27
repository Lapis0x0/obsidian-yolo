import type { DeepPartial, TranslationKeys } from '../types'

export const it: DeepPartial<TranslationKeys> = {
  commands: {
    openChat: 'Apri chat',
    openChatSidebar: 'Apri chat (barra laterale)',
    newChatCurrentView: 'Nuova chat',
    openYoloNewChat: 'YOLO: Apri finestra chat',
    openNewChatTab: 'Apri nuova chat (nuova scheda)',
    openNewChatSplit: 'Apri nuova chat (divisione destra)',
    openNewChatWindow: 'Apri nuova chat (nuova finestra)',
    openChatHistory: 'Apri cronologia chat',
    exportCurrentConversationToVault:
      'Esporta la conversazione attuale nel vault',
    addSelectionToChat: 'Aggiungi selezione alla chat',
    addFileToChat: 'Aggiungi file alla chat',
    addFolderToChat: 'Aggiungi cartella alla chat',
    rebuildVaultIndex: 'Ricostruisci indice completo del vault',
    updateVaultIndex: 'Aggiorna indice per file modificati',
    triggerQuickAskContinue: 'Apri Quick Ask in modalità continua scrittura',
    triggerQuickAsk: 'Attiva quick ask',
    triggerTabCompletion: 'Attiva completamento tab',
    acceptInlineSuggestion: 'Accetta completamento',
    capturePdfRegion: 'Cattura regione PDF nella chat',
  },

  // Italian does not yet translate the full config-transfer surface. Keep
  // these newly selectable catalog labels localized while other strings use
  // their call-site fallbacks.
  configTransfer: {
    export: {
      moduleConfigsUnredactedOnly:
        'La configurazione dei moduli può contenere credenziali private del modulo ed è esclusa dalle esportazioni oscurate.',
    },
    import: {
      noticePartialModuleConfig:
        'Le impostazioni Host sono state importate, ma la configurazione dei moduli non è riuscita. Alcune impostazioni dei moduli potrebbero essere state scritte e non sono state annullate.',
    },
    keyLabels: {
      jsSandbox: 'Autorizzazioni sandbox JS',
      pluginUpdateAutoDownloadEnabled:
        'Scarica automaticamente gli aggiornamenti del plugin',
      moduleConfigs: 'Configurazione moduli',
    },
  },

  common: {
    save: 'Salva',
    cancel: 'Annulla',
    delete: 'Elimina',
    edit: 'Modifica',
    add: 'Aggiungi',
    adding: 'Aggiunta in corso...',
    probingDimension: 'Rilevamento dimensioni...',
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
    rows: 'righe',
    columns: 'colonne',
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
    runtimeSelector: {
      modeAccessibleLabel: 'Modalità chat',
      chatLabel: 'Agent',
      cliLabel: 'CLI',
      chatDescription: 'Chat integrata di YOLO',
      cliDescription: 'Usa CLI per attività',
      accessibleLabel: 'Provider CLI: {runtime}',
      menuLabel: 'Provider CLI',
      claudeCodeLabel: 'Claude Code',
      claudeCodeShortLabel: 'CC',
      claudeCodeDescription: 'Claude Code su questo dispositivo',
      codexLabel: 'Codex',
      codexDescription: 'Codex su questo dispositivo',
      hermesLabel: 'Hermes',
      hermesDescription: 'Hermes su questo dispositivo',
      piLabel: 'Pi',
      piDescription: 'Pi su questo dispositivo',
    },
    chatList: {
      searchPlaceholder: 'Cerca conversazioni',
      empty: 'Nessuna conversazione',
      noTaskConversations: 'Nessuna conversazione di attività',
      historySections: 'Categorie di conversazioni',
      myConversations: 'Le mie conversazioni',
      taskConversations: 'Conversazioni di attività',
      taskConversationSources: 'Origini delle conversazioni di attività',
      allSources: 'Tutte',
      externalAgent: 'Agent esterno',
      current: 'Attuale',
      pinConversation: 'Fissa',
      unpinConversation: 'Rimuovi fissaggio',
      retryTitle: 'Riprova titolo',
      archived: 'Archiviate',
      hideArchived: 'Nascondi archiviate',
      exportConversation: 'Esporta conversazione nel vault',
      exportShort: 'Esporta',
      moreActions: 'Altre azioni',
      confirmDelete: 'Clicca di nuovo per eliminare',
      openHistory: 'Cronologia chat',
      legend: {
        navigate: 'Naviga',
        open: 'Apri',
        delete: 'Elimina',
        pin: 'Fissa',
        rename: 'Rinomina',
      },
    },
    chat: {
      exportSuccess: 'Chat esportata in {path}',
      exportError: 'Impossibile esportare la conversazione',
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
      referenceRulesPlaceholder:
        'Seleziona le cartelle il cui contenuto deve essere completamente iniettato.',
      knowledgeBaseTitle: 'Base di conoscenza',
      knowledgeBasePlaceholder:
        'Seleziona cartelle o file usati come ambito di recupero (lascia vuoto per tutti).',
      knowledgeBaseHint:
        "Abilita la ricerca embeddings per limitare l'ambito di recupero.",
    },
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
    length: {
      adjust: 'Regola lunghezza',
      condense: 'Sintetizza',
      expand: 'Espandi',
      freeExpand: 'Espansione libera',
      handle: 'Trascina per regolare la lunghezza',
      noEditor: "Impossibile accedere all'editor corrente",
      noSelection: 'Seleziona prima il testo da regolare.',
      noEditorView: "Impossibile accedere alla vista dell'editor",
      tableUnsupported: 'Le selezioni di tabella non sono ancora supportate.',
    },
  },

  settings: {
    title: 'Impostazioni Yolo',
    tabs: {
      models: 'Modelli',
      editor: 'Sparkle',
      knowledge: 'Conoscenza',
      tools: 'Strumenti',
      agent: 'Agent',
      modules: 'Moduli',
      others: 'Altro',
    },
    supportYolo: {
      name: 'Supporta il progetto',
      desc: 'Se trovi utile questo plugin, considera di supportarne lo sviluppo!',
      afdian: 'Afdian (CN)',
      buyMeACoffee: 'Buy Me a Coffee',
      reportBug: 'Segnala bug',
      featureRequest: 'Richiedi funzione',
    },
    defaults: {
      title: 'Criteri modello predefiniti e prompt',
      defaultChatModel: 'Modello chat predefinito',
      defaultChatModelDesc:
        'Scegli il modello che vuoi usare per la chat nella barra laterale.',
      chatTitleModel: 'Modello per titolo conversazione',
      chatTitleModelDesc:
        'Scegli il modello usato per assegnare automaticamente un nome alle conversazioni.',
      streamFallbackRecovery: 'Abilita recupero automatico',
      streamFallbackRecoveryDesc:
        'Quando la richiesta primaria in streaming scade o fallisce, esegue un secondo tentativo in modalita non streaming.',
      primaryRequestTimeout: 'Timeout richiesta primaria (secondi)',
      primaryRequestTimeoutDesc:
        'Quanto attendere prima che la richiesta primaria in streaming venga considerata in timeout. Questo timeout si applica sempre; se il recupero automatico e attivo, dopo il timeout verra tentato un fallback non streaming. Predefinito: 60 secondi.',
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
      tabCompletionSystemPrompt: 'Prompt di sistema completamento tab',
      tabCompletionSystemPromptDesc:
        'Messaggio di sistema applicato quando si generano suggerimenti di completamento tab; lascia vuoto per usare quello predefinito incorporato.',
    },
    modules: {
      title: 'Moduli',
      description:
        'Visualizza le funzionalità opzionali di Yolo e il loro stato corrente.',
      manage: 'Gestisci moduli',
      manageDescription:
        'Installa le funzionalità YOLO e verifica che siano pronte per l’uso.',
      navigation: 'Navigazione impostazioni moduli',
      enabled: 'Attivi',
      enabledEmpty: 'Nessun modulo attivo.',
      disabled: 'Disattivati',
      disabledEmpty: 'Nessun modulo disattivato.',
      settings: 'Impostazioni',
      updateAndEnable: 'Aggiorna e attiva',
      loading: 'Caricamento moduli…',
      loadError: 'Impossibile caricare i moduli.',
      settingsSaveError: 'Impossibile salvare le impostazioni del modulo',
      catalogError: 'Catalogo: {error}',
      installedError: 'Moduli installati: {error}',
      intentError: 'Intento del modulo: {error}',
      empty: 'Nessun modulo trovato.',
      installed: 'Installati',
      installedDescription: 'Moduli presenti in questa installazione.',
      installedEmpty: 'Nessun modulo installato.',
      available: 'Disponibili',
      availableDescription:
        'Moduli disponibili per questa installazione di Yolo.',
      availableEmpty: 'Nessun altro modulo disponibile.',
      version: 'Versione {version}',
      availableVersion: 'Aggiornamento {version}',
      install: 'Installa',
      update: 'Aggiorna',
      installing: 'Installazione…',
      updating: 'Aggiornamento…',
      reload: 'Riprova',
      reloading: 'Nuovo tentativo…',
      candidateUnavailable:
        'Al momento non è possibile installare {name}. Il download potrebbe essere già in corso oppure il catalogo potrebbe essere cambiato.',
      installError: 'Impossibile installare {name}: {error}',
      updateError: 'Impossibile aggiornare {name}: {error}',
      activationPendingDetail:
        'La versione {version} è pronta e può essere attivata di nuovo.',
      intentLabel: 'Intento',
      intentUnknown: 'Non disponibile',
      intentInstalledEnabled: 'Installato · abilitato',
      intentInstalledDisabled: 'Installato · disabilitato',
      intentUninstalled: 'Non installato',
      readinessLabel: 'Disponibilità',
      readiness: {
        notInstalled: 'Non installato',
        pending: 'In attesa o da riprovare',
        ready: 'Pronto su questo dispositivo',
        failed: 'Non riuscito',
      },
      incompatibleReason: 'Non compatibile: {reason}',
      compatibility: {
        platform: 'piattaforma',
        hostApi: 'aggiorna YOLO Core',
        dataSchema: 'schema dei dati',
      },
      retry: 'Riprova',
      actionError: 'Impossibile modificare {name}: {error}',
      failure: {
        downloadTimeout:
          'Il download del modulo è scaduto sia su Cloudflare sia su GitHub. Controlla la rete o il proxy e riprova.',
        download:
          'Impossibile scaricare il modulo da Cloudflare o GitHub. Controlla la rete o il proxy e riprova.',
        integrity:
          'Il modulo scaricato non ha superato il controllo di integrità, quindi l’installazione è stata interrotta. Riprova e contatta lo sviluppatore se il problema persiste.',
        activation:
          'Il modulo è stato scaricato ma non può essere avviato. Riprova e contatta lo sviluppatore se il problema persiste.',
        unknown: 'Operazione del modulo non riuscita.',
        diagnostic: 'Dettagli: {detail}',
      },
      actions: {
        install: 'Installa',
        installBusy: 'Installazione…',
        enable: 'Abilita',
        enableBusy: 'Abilitazione…',
        disable: 'Disabilita',
        disableBusy: 'Disabilitazione…',
        uninstall: 'Disinstalla',
        uninstallBusy: 'Disinstallazione…',
      },
      statuses: {
        available: 'Disponibile',
        installed: 'Installato',
        active: 'Attivo',
        disabled: 'Disabilitato',
        updateAvailable: 'Aggiornamento disponibile',
        activationPending: 'Attivazione in attesa',
        failed: 'Non riuscito',
      },
      runtimeComponents: {
        title: 'Componenti runtime',
        description:
          'Questi componenti supportano alcune funzionalità di YOLO.',
        tokenizer: {
          name: 'Tokenizer',
          description: 'Conta i token del contesto e degli strumenti Agent.',
          impact:
            'Disattivandolo, il budget preciso dei token non è disponibile.',
        },
        pdfEngine: {
          name: 'Motore PDF',
          description:
            'Estrae testo, renderizza pagine e prepara intervalli PDF.',
          impact:
            'Disattivandolo, la lettura PDF e gli strumenti pagina non funzionano.',
        },
        bashEngine: {
          name: 'Motore Bash',
          description:
            'Fornisce una shell virtuale allo strumento bash per cercare e organizzare i file del vault.',
          impact:
            'Disattivandolo, lo strumento bash non è disponibile e il modello perde la ricerca e l’organizzazione dei file.',
        },
        embeddingEngine: {
          name: 'Motore di embedding',
          description:
            'Esegue modelli di embedding locali sul dispositivo per un’indicizzazione privata e offline.',
          impact:
            'Disattivandolo, i modelli di embedding locali non sono disponibili; il RAG utilizza un provider di embedding remoto.',
        },
        statuses: {
          missing: 'In attesa di installazione',
          downloading: 'Download in corso',
          ready: 'Pronto',
          loading: 'Caricamento',
          active: 'In uso',
          quiescing: 'Completamento attività in corso',
          disabled: 'Disabilitato',
          failed: 'Non riuscito',
        },
      },
    },
    continuationQuickActions: {
      quickActionsTitle: 'Preset di continuazione scrittura',
      quickActionsDesc:
        'Personalizza le azioni rapide e i prompt mostrati nella modalità di continuazione di Quick Ask',
      quickActionsModalTitle: 'Preset di continuazione Quick Ask',
      configureActions: 'Configura azioni rapide',
      actionsCount: 'Azioni rapide configurate: {count}',
      addAction: 'Aggiungi azione',
      resetToDefault: 'Ripristina predefiniti',
      confirmReset:
        'Sei sicuro di voler ripristinare le azioni rapide predefinite ed eliminare tutte le impostazioni personalizzate?',
      resetConfirmTitle: 'Ripristina i preset di continuazione scrittura',
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
      quickActionsTitle: 'Azioni rapide Cursor Chat',
      quickActionsDesc:
        'Personalizza le azioni rapide e i prompt visualizzati dopo la selezione del testo',
      configureActions: 'Configura azioni rapide',
      actionsCount: 'Azioni rapide configurate: {count}',
      addAction: 'Aggiungi azione rapida',
      resetToDefault: 'Ripristina predefiniti',
      confirmReset:
        'Sei sicuro di voler ripristinare le azioni rapide predefinite ed eliminare tutte le impostazioni personalizzate?',
      resetConfirmTitle: 'Ripristina azioni rapide Cursor Chat',
      actionLabel: 'Etichetta azione',
      actionLabelDesc: "Testo visualizzato nell'azione rapida",
      actionLabelPlaceholder: 'Ad esempio, spiega',
      actionMode: 'Modalita',
      actionModeDesc:
        'Le prime due usano Quick Ask: Ask invia automaticamente e Rewrite entra nella modalita anteprima. Le ultime due usano la Chat: puoi solo precompilare la casella di input oppure inviare subito.',
      actionModeAsk: 'Quick Ask ask',
      actionModeChatInput: 'Aggiungi alla casella chat',
      actionModeChatSend: 'Aggiungi alla casella chat e invia',
      actionModeRewrite: 'Quick Ask rewrite',
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
      fixedActionHint: 'Azione predefinita',
      hideFixedAction: 'Nascondi in Cursor Chat',
      showFixedAction: 'Mostra in Cursor Chat',
    },
    chatPreferences: {
      title: 'Preferenze chat',
      chatFontScale: 'Scala interfaccia chat',
      chatFontScaleDesc:
        "Regola la scala complessiva dell'interfaccia chat (predefinito 100%).",
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
      systemPromptDesc: "Questo prompt viene aggiunto all'inizio di ogni chat.",
      systemPromptPlaceholder: 'Ad esempio, Sei un esperto programmatore...',
      defaultAssistantName: 'Nuovo assistente',
      actions: 'Azioni',
      deleteConfirmTitle: 'Elimina assistente',
      deleteConfirmMessagePrefix: 'Sei sicuro di voler eliminare',
      deleteConfirmMessageSuffix: '?',
      addAssistantAria: 'Aggiungi nuovo assistente',
      deleteAssistantAria: 'Elimina assistente',
      dragHandleAria: 'Trascina per riordinare',
      duplicate: 'Duplica',
      copySuffix: '(copia)',
      currentBadge: 'Corrente',
      manageAll: 'Gestisci tutti…',
    },
    agent: {
      title: 'Agent',
      desc: "Gestisci la disponibilità globale degli strumenti. Dopo l'abilitazione, gli strumenti possono essere selezionati dagli agent; l'uso effettivo va comunque abilitato nel singolo agent.",
      globalCapabilities: 'Capacità globali',
      mcpServerCount: '{count} server strumenti personalizzati (MCP) connessi',
      tools: 'Strumenti',
      toolsCount: '{count} strumenti',
      toolsCountWithEnabled: '{count} strumenti (abilitati {enabled})',
      mcpLoadingStatus: 'Caricamento di {count} MCP…',
      mcpErrorStatus: '{count} MCP non connessi',
      skills: 'Competenze',
      skillsCount: '{count} competenze',
      skillsCountWithEnabled: '{count} competenze (abilitate {enabled})',
      skillsGlobalDesc:
        'Le skill vengono rilevate dalle skill integrate, dai file {path}/*.md e dai pacchetti {path}/<folder>/SKILL.md. Disabilitale qui per bloccarle su tutti gli agent.',
      yoloBaseDir: 'Cartella base YOLO',
      yoloBaseDirDesc:
        'Inserisci un percorso relativo al vault (senza / iniziale). Esempio: YOLO nella radice del vault, oppure setting/YOLO nella cartella setting.',
      yoloBaseDirPlaceholder: 'YOLO',
      yoloBaseDirHiddenPath:
        'La cartella base YOLO non può usare cartelle nascoste. Rimuovi il punto iniziale dal nome, ad esempio cambia .yolo in yolo.',
      yoloBaseDirMigrated:
        'La cartella base YOLO ora usa {target}, che Obsidian può indicizzare.',
      yoloBaseDirMigrationConflict:
        'La cartella base YOLO non è stata spostata perché {target} esiste già. Le impostazioni esistenti sono state mantenute.',
      yoloBaseDirMigrationFailed:
        'Impossibile migrare la cartella base YOLO. Le impostazioni esistenti sono state mantenute.',
      yoloBaseDirMigrationRollbackFailed:
        'YOLO è stato spostato da {source} a {target}, ma non è stato possibile aggiornare le impostazioni né annullare lo spostamento. Sposta manualmente la cartella in {source} prima di continuare.',
      yoloBaseDirMigrationManualRepair:
        'La cartella base YOLO {source} è nascosta ma non può essere migrata automaticamente in sicurezza. Scegli una cartella visibile e sposta manualmente i file YOLO.',
      yoloBaseDirConflictTitle: 'La cartella base YOLO non è stata spostata',
      yoloBaseDirConflictMessage:
        '{target} esiste già e contiene file. Nessun contenuto è stato spostato per evitare sovrascritture o fusioni. Scegli una cartella vuota o inesistente.',
      skillsSourcePath:
        'Origine: skill integrate + {path}/*.md + {path}/<folder>/SKILL.md',
      refreshSkills: 'Aggiorna',
      skillsEmptyHint:
        'Nessuna skill trovata. Crea un file Markdown o una cartella contenente SKILL.md in {path}.',
      createSkillTemplates: 'Inizializza sistema Skills',
      skillsTemplateCreated: 'Sistema Skills inizializzato in {path}.',
      importSkill: 'Importa Skill',
      importSkillDesc:
        'Importa skill in {path}. I file Markdown mantengono il nome; le cartelle mantengono il nome, SKILL.md e tutte le risorse.',
      importSkillDropzoneText: 'Trascina file o cartelle skill qui',
      importSkillBrowseFiles: 'Sfoglia File',
      importSkillBrowseFolder: 'Sfoglia Cartella',
      importSkillFileCount: '{count} skill selezionate ({files} file totali)',
      importSkillFilesInPackage: 'file',
      importSkillRemoveFile: 'Rimuovi',
      importSkillConfirm: 'Importa',
      importSkillSuccess: 'Importate con successo {count} skill.',
      importSkillInvalidFile: 'Nessun file o pacchetto skill valido trovato.',
      importSkillReadError: 'Impossibile leggere i file.',
      importSkillErrTooDeep:
        'Il pacchetto skill supera la profondità massima di importazione di {depth}. Non è stato importato nulla.',
      importSkillWriteError: 'Impossibile importare {name}: {error}',
      importSkillErrHeader: '"{name}" non può essere importato:',
      importSkillErrNoSkillMd: 'file SKILL.md mancante nella cartella',
      importSkillErrNoFrontmatter:
        'intestazione metadati (---) mancante in cima al file',
      importSkillErrNoName: 'campo "name" mancante nei metadati',
      importSkillConflictTitle: 'Skill già esistente',
      importSkillConflictMessage:
        'Esiste già una skill con lo stesso nome. Vuoi sovrascriverla?',
      importSkillConflictOverwrite: 'Sovrascrivi tutto',
      importSkillConflictMessageList:
        'Le seguenti skill esistono già: {names}\n\nClicca "Sovrascrivi tutto" per sostituirle, "Salta conflitti" per mantenerle, o chiudi questa finestra per annullare l\'importazione.',
      importSkillConflictSkip: 'Salta conflitti',
      importSkillUnsafePath:
        'Percorso non sicuro rifiutato in "{name}": {path}',
      importSkillDuplicateInBatch:
        'Destinazione di importazione duplicata in questo batch: "{name}" (da "{source}"). Viene mantenuta solo la prima occorrenza.',
      deleteSkillTitle: 'Elimina skill',
      deleteSkillMessage:
        'Sei sicuro di voler eliminare il pacchetto skill "{name}", incluse tutte le risorse? Questa azione non può essere annullata.',
      deleteSkillConfirm: 'Elimina',
      deleteSkillSuccess: '"{name}" è stata eliminata.',
      deleteSkillError: 'Impossibile eliminare "{name}": {error}',
      deleteSkillNotFound: 'Skill non trovata',
      deleteSkillBatchMessage:
        'Sei sicuro di voler eliminare {count} skill, incluse le risorse dei pacchetti? Questa azione non può essere annullata.',
      deleteSkillBatchSuccess: 'Eliminate {count} skill.',
      deleteSkillBatchBtn: 'Elimina',
      deleteSkillSelectAll: 'Seleziona tutto',
      deleteSkillCancel: 'Annulla',
      selectSkills: 'Seleziona',
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
      toolsGroupBuiltinVault: 'Vault',
      toolsGroupBuiltinContext: 'Contesto e memoria',
      toolsGroupBuiltinExternal: 'Esterno',
      noMcpTools: 'Nessuno strumento personalizzato (MCP) rilevato',
      toolsEnabledCount: '{count} abilitati',
      manageTools: 'Gestisci strumenti',
      manageSkills: 'Gestisci competenze',
      enableToolDisclosure: 'Abilita caricamento strumenti su richiesta (Beta)',
      enableToolDisclosureDesc:
        'Gli strumenti opzionali partono con descrizioni brevi, poi caricano i dettagli completi quando servono. Consigliato quando sono abilitati molti strumenti MCP. Nota: questo meccanismo dipende dalle capacità di tool-use del modello — alcuni modelli potrebbero non riconoscere in modo affidabile gli strumenti caricati in questo modo.',
      descriptionColumn: 'Descrizione',
      builtinFsReadLabel: 'Leggi',
      builtinFsReadDesc:
        'Leggi file del vault, skill o pagine web aperte (browser://)',
      builtinContextPruneToolResultsLabel: 'Pota risultati strumenti',
      builtinContextPruneToolResultsDesc:
        'Escludi i risultati storici degli strumenti dal contesto futuro. Nota: questo strumento può invalidare la cache del prompt e aumentare il costo delle richieste.',
      builtinContextCompactLabel: 'Compatta contesto',
      builtinContextCompactDesc:
        'Comprimi la cronologia meno recente in un riepilogo',
      builtinToolSearchLabel: 'Carica strumento',
      builtinToolSearchDesc:
        'Carica gli schemi completi degli strumenti su richiesta',
      builtinFsEditLabel: 'Modifica testo',
      builtinFsEditDesc: 'Modifica il testo di un singolo file',
      builtinBashLabel: 'Terminale virtuale',
      builtinBashDesc:
        'Cerca e ispeziona i file del vault, più operazioni su percorsi mkdir/mv/rm',
      safetyControls: 'Controlli di sicurezza',
      safetyControlsDesc:
        'Configura una revisione aggiuntiva prima che gli agent eseguano operazioni rischiose sui file.',
      fsEditReviewToggle: 'Richiedi approvazione prima di modificare i file',
      fsEditReviewToggleDesc:
        "Se abilitato, le modifiche fs_edit dell'agent aprono la revisione inline/apply prima di scrivere il file.",
      builtinFsEditOpsLabel: 'Set modifica file',
      builtinFsEditOpsDesc:
        'Modifica testo mirato o scrive il contenuto completo del file',
      builtinMemoryOpsLabel: 'Set strumenti memoria',
      builtinMemoryOpsDesc: 'Aggiungi, aggiorna ed elimina memoria',
      builtinMemoryAddLabel: 'Aggiungi memoria',
      builtinMemoryAddDesc:
        "Aggiunge una memoria globale o dell'assistant con id assegnato automaticamente.",
      builtinMemoryUpdateLabel: 'Aggiorna memoria',
      builtinMemoryUpdateDesc: 'Aggiorna una memoria esistente tramite id.',
      builtinMemoryDeleteLabel: 'Elimina memoria',
      builtinMemoryDeleteDesc: 'Elimina una memoria esistente tramite id.',
      builtinOpenSkillLabel: 'Apri skill',
      builtinOpenSkillDesc: 'Carica uno skill markdown',
      builtinWebSearchLabel: 'Ricerca web',
      builtinWebSearchDesc:
        'Cerca sul web tramite il provider configurato e restituisce risultati con snippet.',
      builtinWebScrapeLabel: 'Scrape web',
      builtinWebScrapeDesc:
        'Recupera il contenuto completo di un singolo URL tramite il provider configurato.',
      builtinWebOpsLabel: 'Set strumenti ricerca web',
      builtinWebOpsDesc: 'Ricerca web e scraping di pagine',
      builtinJsEvalLabel: 'Sandbox di analisi',
      builtinJsEvalDesc:
        'Esegue JavaScript in una sandbox isolata per calcoli precisi, statistiche in batch ed elaborazione dati; le capacità di ricerca, lettura del vault e rete si concedono singolarmente.',
      builtinTerminalCommandLabel: 'Comandi del terminale',
      builtinTerminalCommandDesc:
        'Esegue comandi nel terminale locale, solo desktop',
      builtinDelegateSubagentLabel: 'Delega a subagent',
      builtinDelegateSubagentDesc:
        'Avvia in modo asincrono un subagent temporaneo e isolato per completare un task autonomo.',
      builtinTodoWriteLabel: 'Lista delle attività',
      builtinTodoWriteDesc:
        "Consente all'agente di pianificare e tracciare autonomamente i progressi su task in più fasi. Solo modalità agente.",
      builtinAskUserQuestionLabel: "Chiedi all'utente",
      builtinAskUserQuestionDesc:
        "Chiede all'utente quando mancano informazioni necessarie e riprende dopo la risposta.",
      editorDefaultName: 'Nuovo agent',
      editorIntro:
        'Configura le capacità, il modello e il comportamento di questo agent.',
      editorTabProfile: 'Profilo',
      editorTabTools: 'Strumenti',
      editorTabSkills: 'Competenze',
      editorTabWorkspace: 'Spazio di lavoro',
      workspace: {
        enableTitle: "Limita l'ambito di lavoro autonomo",
        enableDesc:
          "Se disattivato, l'agent può esplorare e modificare l'intero vault in autonomia. Se attivo, le sue azioni autonome di navigazione e modifica restano entro gli ambiti qui sotto — i file che menzioni con @ o che hai aperto non sono mai limitati.",
        toolBypassNotice:
          'Gli agent con comandi da terminale o strumenti MCP di terze parti abilitati possono aggirare questo ambito: non è un confine di sicurezza.',
      },
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
        'Istruzione comportamentale principale per questo agent.',
      editorSystemPromptExpand: 'Espandi editor',
      editorSystemPromptCollapse: 'Chiudi editor espanso',
      editorEnableProjectInstructions: 'Carica file di istruzioni del progetto',
      editorEnableProjectInstructionsDesc:
        'Carica automaticamente AGENTS.md e CLAUDE.md dalla radice del vault per questo agent. Compatibile con Codex / Claude Code / Cursor e strumenti analoghi.',
      editorEnableTools: 'Abilita strumenti',
      editorEnableToolsDesc: 'Consenti a questo agent di chiamare strumenti',
      editorIncludeBuiltinTools: 'Includi strumenti integrati',
      editorIncludeBuiltinToolsDesc:
        'Consenti strumenti file locali del vault per questo agent',
      toolApproval: 'Approvazione',
      toolApprovalFullAccess: 'Accesso completo',
      toolApprovalRequire: 'Richiedi approvazione',
      toolApprovalDangerousOnly: 'Approva solo operazioni pericolose',
      toolDisclosureAuto: 'Auto',
      toolDisclosureAutoSelect: 'Selezione automatica',
      toolDisclosureAlways: 'In contesto',
      toolDisclosureMixed: 'Misto',
      toolDisclosureOnDemand: 'Su richiesta',
      editorEnabled: 'Abilitato',
      editorDisabled: 'Disabilitato',
      editorModel: 'Modello',
      editorModelDesc: 'Seleziona il modello usato da questo agent',
      followDefaultModel: 'Segui modello predefinito',
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
      agentCapabilitiesBlockTitle: 'Capacità Agent',
      focusSyncTitle: 'Sincronizzazione del focus',
      focusSyncDesc:
        "Se abilitato, l'AI percepisce dove ti trovi nella nota, nel PDF o nella pagina web che stai visualizzando. Il contenuto completo della pagina web si legge con fs_read tramite un percorso browser://.",
      timeContextTitle: 'Consapevolezza dell ora corrente',
      timeContextDesc:
        'Indica al modello l ora corrente all invio di ogni messaggio.',
      imageReadingBlockTitle: 'Lettura immagini',
      imageReadingEnabled: 'Lettura immagini',
      imageReadingEnabledDesc:
        'Estrai automaticamente le immagini incorporate durante la lettura dei file Markdown, inviandole al modello come contenuto multimodale.',
      externalImageFetchEnabled: 'Scarica URL immagini esterne',
      externalImageFetchEnabledDesc:
        'Scarica anche le immagini referenziate tramite URL http(s) nel Markdown (image host, CDN). Disabilitato per impostazione predefinita — l’attivazione invia richieste a host di terze parti. Timeout di 5s per richiesta; immagini oltre 10MB vengono ignorate.',
      imageCompressionEnabled: 'Compressione immagini',
      imageCompressionEnabledDesc:
        'Comprimi le immagini estratte per ridurre il consumo di token e la dimensione del trasferimento.',
      imageCompressionQuality: 'Qualità di compressione',
      imageCompressionQualityDesc:
        'Rapporto di compressione immagini (1-100). Controlla sia dimensioni che qualità, es. 60 riduce al 60% con qualità 60%.',
      cliRuntimesBlockTitle: 'Runtime CLI',
      claudeCliPathName: 'Percorso CLI di Claude Code',
      claudeCliPathDesc:
        'Percorso personalizzato dell\'eseguibile claude — incolla l\'output di "which claude" ("where claude" su Windows). Lascia vuoto per il rilevamento automatico. Salvato solo su questo dispositivo.',
      codexCliPathName: 'Percorso CLI di Codex',
      codexCliPathDesc:
        'Percorso personalizzato dell\'eseguibile codex — incolla l\'output di "which codex" ("where codex" su Windows). Lascia vuoto per il rilevamento automatico. Salvato solo su questo dispositivo.',
      hermesCliPathName: 'Percorso CLI di Hermes',
      hermesCliPathDesc:
        'Percorso personalizzato dell\'eseguibile hermes — incolla l\'output di "which hermes" ("where hermes" su Windows). Lascia vuoto per il rilevamento automatico. Salvato solo su questo dispositivo.',
      piCliPathName: 'Percorso CLI di Pi',
      piCliPathDesc:
        'Percorso personalizzato dell\'eseguibile pi — incolla l\'output di "which pi" ("where pi" su Windows). Lascia vuoto per il rilevamento automatico. Salvato solo su questo dispositivo.',
      cliPathMissing:
        'Questo percorso non esiste su questo dispositivo; verrà usato il rilevamento automatico.',
      autoContextCompactionBlockTitle: 'Compattazione contesto',
      autoContextCompaction: 'Compattazione automatica del contesto',
      autoContextCompactionDesc:
        'Quando il contesto raggiunge la soglia, ricorda all’Agent di eseguire il comando di compattazione contesto.',
      autoContextCompactionThresholdMode: 'Modalita soglia',
      autoContextCompactionModeTokens: 'Token di prompt assoluti',
      autoContextCompactionModeRatio: 'Quota della finestra di contesto',
      autoContextCompactionThresholdTokens: 'Soglia token di prompt',
      autoContextCompactionThresholdTokensDesc:
        'Attiva quando i prompt_tokens segnalati dall’ultima risposta raggiungono almeno questo valore.',
      autoContextCompactionThresholdRatioPercent:
        'Uso finestra di contesto (%)',
      autoContextCompactionThresholdRatioPercentDesc:
        'Attiva quando prompt_tokens diviso per la finestra massima del modello di chat raggiunge questa percentuale. Richiede max context sul modello.',
      mcpServerBlockTitle: 'Accesso per agenti esterni',
      mcpServerEnabled: 'Consenti accesso agli agenti esterni',
      mcpServerDesc:
        'Consenti agli agenti esterni di cercare nel Vault tramite MCP e delegare attivita agli agenti YOLO configurati.',
      mcpServerDesktopOnly: 'Il servizio MCP e disponibile solo su desktop.',
      mcpServerClientConfig: 'Configurazione connessione MCP',
      mcpServerCopyConfig: 'Copia',
      mcpServerError: 'Avvio non riuscito',
      mcpServerConfigCopied: 'Configurazione MCP copiata.',
      mcpServerCopyFailed: 'Impossibile copiare la configurazione MCP.',
    },
    terminalCommand: {
      openSettings: 'Configura comando terminale',
      blockedPrefixes: 'Prefissi comando bloccati',
      blockedPrefixesDesc:
        "I comandi che corrispondono a questi prefissi verranno rifiutati prima dell'esecuzione.",
      matchingRule:
        'La corrispondenza usa il primo token del comando: rm blocca rm -rf /, ma non npm run build.',
      addPrefixPlaceholder: 'Prefisso comando, es. rm',
      resetDefaults: 'Ripristina predefiniti',
    },
    webSearch: {
      modalTitle: 'Impostazioni ricerca web',
      openSettings: 'Configura provider di ricerca web',
      intro:
        'Configura i provider di ricerca usati dallo strumento agent web_search integrato. Il provider predefinito qui sotto verrà usato dall’agent.',
      providersHeader: 'Provider',
      addProvider: 'Aggiungi provider',
      editProvider: 'Modifica provider',
      empty:
        'Nessun provider configurato. Aggiungine uno per abilitare lo strumento web_search.',
      colName: 'Nome',
      colType: 'Tipo',
      colDefault: 'Predefinito',
      colActions: 'Azioni',
      deleteFailed: 'Impossibile eliminare il provider.',
      commonHeader: 'Comuni',
      resultSize: 'Numero risultati',
      resultSizeDesc:
        'Numero massimo di risultati restituiti al modello per ricerca.',
      searchTimeout: 'Timeout ricerca (ms)',
      scrapeTimeout: 'Timeout scrape (ms)',
      searchTimeoutLabel: 'Timeout ricerca',
      searchTimeoutDesc:
        'Tempo massimo di attesa per una chiamata di ricerca del provider.',
      scrapeTimeoutLabel: 'Timeout scrape',
      scrapeTimeoutDesc:
        'Tempo massimo di attesa per una singola chiamata web_scrape.',
      unitResults: 'elementi',
      tagDefault: 'Predefinito',
      failoverNotice:
        "Le chiamate fallite non vengono rilanciate silenziosamente su un altro provider — l'errore viene passato al modello perché l'agent decida se riprovare o cambiare strategia.",
      providerCount: 'Provider totali',
      types: {
        tavily: 'Tavily',
        jina: 'Jina',
        searxng: 'SearXNG',
        bing: 'Bing (senza chiave)',
        'gemini-grounding': 'Gemini (Grounding)',
        grok: 'Grok',
        zhipu: 'Zhipu Web Search',
        exa: 'Exa',
      },
      fieldName: 'Nome visualizzato',
      fieldApiKey: 'API key',
      fieldDepth: 'Profondità',
      fieldSearchUrl: 'URL ricerca',
      fieldScrapeUrl: 'URL scrape',
      fieldUseProviderScrapeApi: 'Usa API scrape del provider',
      fieldUseProviderScrapeApiDesc:
        'Se attivo, web_scrape usa l\u2019API extract di questo provider. Se disattivo, web_scrape usa lo scraper generico integrato (HTML statico, senza consumo API aggiuntivo).',
      fieldBaseUrl: 'Base URL',
      fieldLanguage: 'Lingua',
      fieldEngines: 'Motori (separati da virgola)',
      fieldUsername: 'Username Basic Auth',
      fieldPassword: 'Password Basic Auth',
      fieldModel: 'Modello',
      fieldSystemPrompt: 'System prompt',
      fieldEnableX: 'Cerca anche su X',
      fieldZhipuEngine: 'Motore di ricerca',
      fieldZhipuContentSize: 'Dimensione contenuto',
      fieldZhipuRecency: 'Filtro temporale',
      fieldZhipuDomainFilter: 'Filtro dominio (opzionale)',
      bingNote:
        'Bing non richiede API key. Il provider effettua scraping della pagina pubblica dei risultati; l’affidabilità dipende dalle misure anti-bot di Bing.',
    },
    providers: {
      title: 'Provider',
      desc: 'Configura i provider di modelli AI e le loro chiavi API.',
      howToGetApiKeys: 'Come ottenere le chiavi API',
      addProvider: 'Aggiungi provider',
      pickerTitle: 'Aggiungi provider',
      pickerSearchPlaceholder: 'Cerca provider · premi Invio',
      pickerCustomLabel: 'Provider personalizzato',
      pickerCustomDesc: 'URL base + chiave API',
      pickerEmpty: 'Nessun provider corrispondente',
      categoryAll: 'Tutti',
      categoryMain: 'Internazionale',
      categoryCn: 'Cina',
      categoryGateway: 'Aggregatori',
      categoryCloud: 'Cloud',
      categoryLocal: 'Locali',
      badgeOpenAiCompatible: 'Compatibile OpenAI',
      badgeNative: 'Protocollo nativo',
      badgeOAuth: 'OAuth',
      badgeSponsor: 'Sponsor',
      badgeAdded: 'Aggiunto',
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
      getApiKey: 'Ottieni chiave API',
      apiKeyDesc: 'La tua chiave API per questo provider.',
      apiKeyPlaceholder: 'Inserisci la tua chiave API',
      baseUrl: 'URL base',
      baseUrlDesc: 'URL endpoint API personalizzato (facoltativo).',
      baseUrlPlaceholder: 'Ad esempio, https://api.openai.com/v1',
      apiUrlPreviewLabel: 'Anteprima:',
      noStainlessHeaders: 'Nessun header stainless',
      noStainlessHeadersDesc:
        'Disabilita gli header SDK stainless (richiesto per alcuni provider compatibili).',
      useObsidianRequestUrl: 'Usa requestUrl di Obsidian',
      useObsidianRequestUrlDesc:
        'Usa requestUrl di Obsidian per aggirare le restrizioni CORS. Le risposte in streaming verranno bufferizzate.',
      requestTransportMode: 'Metodo richiesta di rete',
      requestTransportModeDesc:
        'Scegli come questo provider invia le richieste di rete su questo dispositivo. La connessione diretta desktop e consigliata su desktop. Su mobile, passa alla richiesta integrata di Obsidian se le richieste browser hanno problemi di streaming o rete.',
      requestTransportModeAuto: 'Auto (consigliato)',
      requestTransportModeBrowser: 'Richiesta browser',
      requestTransportModeObsidian: 'Richiesta integrata Obsidian',
      requestTransportModeNode: 'Connessione diretta desktop (consigliata)',
      responseStreamingMode: 'Modalita streaming risposta',
      responseStreamingModeDesc:
        'Controlla se questo provider usa risposte streaming o non streaming.',
      responseStreamingModeAuto: 'Auto (predefinito)',
      responseStreamingModeStreaming: 'Streaming',
      responseStreamingModeNonStreaming: 'Non streaming',
      promptCaching: 'Cache del prompt',
      promptCachingDesc:
        "Abilita la cache effimera dei prompt Anthropic. Riutilizza prompt di sistema, strumenti e cronologia tra i turni per ridurre i token di input. Le scritture in cache hanno un sovrapprezzo del 25%; le letture costano circa il 10% del normale. Disponibile quando il tipo API del provider è Anthropic; l'upstream deve supportare il campo cache_control.",
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
      chatgptOAuthBrowserLogin: 'Accesso dal browser',
      chatgptOAuthDeviceLogin: 'Accesso con codice dispositivo',
      chatgptOAuthBrowserConnecting: 'Apertura del browser...',
      chatgptOAuthDeviceConnecting: 'In attesa di autorizzazione...',
      chatgptOAuthBrowserDesktopOnly:
        "L'accesso dal browser è disponibile solo su desktop.",
      chatgptOAuthBrowserOpened:
        "La pagina di accesso a ChatGPT è stata aperta nel browser. Completa lì l'autorizzazione.",
      chatgptOAuthDeviceOpened:
        'Inserisci il codice dispositivo seguente nella pagina di autorizzazione di ChatGPT.',
      chatgptOAuthConnectedNotice: 'ChatGPT OAuth connesso.',
      chatgptOAuthDisconnectedNotice: 'ChatGPT OAuth disconnesso.',
      chatgptOAuthPortFallback:
        "Usa l'accesso con codice dispositivo: non richiede una porta locale.",
      chatgptOAuthPendingCode: 'Codice dispositivo',
      chatgptOAuthDeviceHelp:
        "Inserisci questo codice nella pagina di autorizzazione entro 15 minuti. Continua solo se hai avviato tu l'accesso.",
      chatgptOAuthCopyCode: 'Copia codice',
      chatgptOAuthCodeCopied: 'Codice dispositivo copiato.',
      chatgptOAuthOpenDevicePage: 'Apri pagina di autorizzazione',
      chatgptOAuthCancelDevice: 'Annulla',
      oauthDesktopOnly:
        'Il login OAuth è disponibile solo su desktop. Collegati prima da desktop.',
      geminiOAuthTitle: 'Gemini OAuth',
      geminiOAuthConnect: 'Connetti',
      geminiOAuthDisconnect: 'Disconnetti',
      geminiOAuthConnecting: 'Connessione in corso...',
      geminiOAuthLoadingStatus: 'Caricamento stato Gemini OAuth...',
      geminiOAuthConnected: 'Connesso',
      geminiOAuthExpires: 'scade',
      geminiOAuthDisconnectedHelp:
        'Non connesso. Connettiti per usare la quota Gemini del tuo account Google.',
      geminiOAuthProject: 'progetto',
      claudeOauthTitle: 'Claude OAuth',
      claudeOauthTokenName: 'Token OAuth',
      claudeOauthTokenDesc:
        'Esegui "claude setup-token" in un terminale e incolla qui il token per chattare con il tuo abbonamento Claude. Questo provider avvia un sottoprocesso claude locale, quindi è disponibile solo su desktop. Incolla un nuovo token quando scade.',
      claudeOauthClear: 'Cancella',
      claudeOauthAutoLogin: 'Accesso automatico',
      claudeOauthAutoLoginConnecting:
        "Accesso in corso, completa l'autorizzazione nel browser…",
      claudeOauthAutoLoginSuccess: 'Accesso Claude connesso.',
      claudeOauthAutoLoginDesktopOnly:
        "L'accesso automatico è disponibile solo su desktop.",
      claudeOauthAutoLoginWindowsNotice:
        "È stata aperta una finestra del terminale per completare l'accesso. Incolla il token stampato nel campo qui sotto una volta terminato.",
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
      connectivityTest: {
        button: 'Test di connettività',
        title: 'Test di connettività',
        testAll: 'Testa tutti',
        retest: 'Ripeti test',
        stop: 'Interrompi',
        test: 'Testa',
        passed: 'Superati',
        statusTesting: 'In corso',
        statusOk: 'OK',
        statusFail: 'Fallito',
        statusTimeout: 'Timeout',
        statusIdle: 'In attesa',
        normalCount: 'OK',
        abnormalCount: 'con errori',
        notTested: 'Non ancora testato',
        noResponse: 'Nessuna risposta',
        firstToken: 'Primo token',
        dims: 'dim',
        noModels: 'Nessun modello configurato per questo provider',
        deleteModel: 'Elimina modello',
        deleteChatModelBlocked:
          'Impossibile eliminare il modello selezionato come chat o titolo',
        deleteEmbeddingModelBlocked:
          'Impossibile eliminare il modello embedding selezionato',
        deleteEmbeddingModelInProgress: 'Eliminazione modello embedding…',
      },
      availableModelsAuto: 'Modelli disponibili (recuperati automaticamente)',
      searchModels: 'Cerca modelli...',
      modeSingle: 'Singolo',
      modeBatch: 'In blocco',
      batchSelectAll: 'Seleziona tutto',
      batchSelected: 'Selezionati',
      batchAlreadyAdded: 'Aggiunto',
      batchAdd: 'Aggiungi selezionati',
      batchHint:
        'I modelli aggiunti in blocco usano le impostazioni predefinite; regolali singolarmente in seguito.',
      fetchModelsFailed: 'Impossibile recuperare i modelli',
      embeddingModelsFirst: 'Modelli embedding (prima)',
      localEmbeddingProviderLabel: 'Locale (sul dispositivo)',
      reasoningType: 'Tipo di ragionamento',
      reasoningTypeDesc: 'Nel dubbio, scegli OpenAI reasoning.',
      reasoningTypeNone: 'Modello non ragionante / predefinito',
      reasoningTypeOpenAI: 'Stile reasoning_effort OpenAI',
      reasoningTypeGemini: 'Stile thinking_budget Gemini',
      reasoningTypeAnthropic: 'Anthropic extended thinking (adaptive + effort)',
      reasoningTypeGeneric: 'Modello di ragionamento generico',
      openaiReasoningEffort: 'Sforzo di ragionamento OpenAI',
      openaiReasoningEffortDesc:
        'Controlla quanto tempo il modello dedica al ragionamento (basso/medio/alto).',
      geminiThinkingBudget: 'Budget di pensiero Gemini',
      geminiThinkingBudgetDesc:
        'Unità: token di thinking. 0 = off; -1 = dinamico (solo Gemini).',
      geminiThinkingBudgetPlaceholder: 'Ad esempio, 10000',
      inputModality: 'Modalità di input',
      inputModalityDesc:
        'Tipi di input effettivamente supportati dal modello. Una scelta errata può causare errori di richiesta.',
      inputModalityText: 'Testo',
      inputModalityVision: 'Immagini',
      inputModalityVisionTooltip:
        'Richiede un modello con capacità di visione native.',
      inputModalityPdf: 'PDF (nativo)',
      inputModalityPdfTooltip:
        'Richiede un modello con supporto PDF nativo (Gemini / Anthropic).',
      builtinToolProvider: 'Strumenti integrati del provider',
      builtinToolProviderDesc:
        'Strumenti nativi forniti dal provider del modello. Indipendenti dagli strumenti integrati di YOLO. L’effetto reale dipende dal supporto del gateway su cui passa la richiesta.',
      builtinToolProviderNone: 'Disabilitato',
      builtinToolProviderGemini: 'Gemini',
      builtinToolProviderGpt: 'OpenAI',
      builtinToolProviderOpenRouter: 'OpenRouter',
      builtinToolProviderGrok: 'Grok',
      builtinToolsGpt: 'Strumenti integrati OpenAI',
      builtinToolsOpenRouter: 'Strumenti integrati OpenRouter',
      builtinToolsGrok: 'Strumenti integrati Grok',
      builtinToolsGemini: 'Strumenti integrati Gemini',
      builtinToolWebSearch: 'Web Search',
      builtinToolWebSearchDesc:
        'Consenti al modello di cercare sul web e restituire fonti citate.',
      builtinToolUrlContext: 'URL Context',
      builtinToolUrlContextDesc:
        'Consenti al modello di leggere i link citati nella conversazione come contesto.',
      openRouterWebSearchEngine: 'Motore di ricerca',
      openRouterWebSearchEngineDesc:
        'Auto lascia decidere a OpenRouter (predefinito). Native usa la ricerca nativa del provider. Exa / Firecrawl / Parallel forzano il motore corrispondente. Firecrawl richiede la tua API key configurata nel pannello OpenRouter.',
      openRouterWebSearchEngineAuto: 'Auto (predefinito)',
      openRouterWebSearchEngineNative: 'Native',
      openRouterWebSearchEngineExa: 'Exa',
      openRouterWebSearchEngineFirecrawl: 'Firecrawl (BYOK)',
      openRouterWebSearchEngineParallel: 'Parallel',
      openRouterWebSearchMaxResults: 'Risultati max',
      openRouterWebSearchMaxResultsDesc:
        'Opzionale, 1–25. Lascia vuoto per usare il valore predefinito di OpenRouter.',
      openRouterWebSearchMaxResultsPlaceholder: 'predefinito',
      sampling: 'Parametri personalizzati',
      restoreDefaults: 'Ripristina predefiniti',
      maxContextTokens: 'Token finestra di contesto',
      maxContextTokensDesc:
        'Compilato automaticamente quando il modello e riconosciuto. Modificalo se il tuo provider usa un limite diverso.',
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
    scope: {
      editRange: 'Modifica ambito',
      currentRules: 'Regole correnti',
      rulesCount: '{{n}} regole',
      noRules: {
        rag: "Nessuna regola: viene indicizzato l'intero vault",
        agent: "Nessuna regola: l'intero vault è disponibile",
      },
      include: 'Includi',
      exclude: 'Escludi',
      clearMark: 'Rimuovi il contrassegno',
      clickAgainToClear: 'Clicca di nuovo per rimuovere',
      follows: 'Segue «{{name}}»',
      reasonExcludedAncestor: 'La cartella superiore «{{name}}» è già esclusa',
      reasonIncludedAncestor: 'Già inclusa dalla cartella superiore «{{name}}»',
      reset: 'Reimposta',
      resetTitle:
        "Ripristina l'ambito predefinito e rimuovi tutte le regole personalizzate",
      onlyWithRules: 'Solo con regole',
      searchFolders: 'Cerca cartelle…',
      searchFoldersOrFiles: 'Cerca cartelle o file…',
      noMatch: {
        rag: 'Nessuna cartella corrispondente',
        agent: 'Nessuna cartella o file corrispondente',
      },
      noRuleYet: 'Ancora nessuna regola',
      fileLabel: 'File',
      fileCount: '{{n}} file',
      modalTitle: {
        rag: "Modifica l'ambito di indicizzazione",
        agent: "Modifica l'ambito dello spazio di lavoro",
      },
      modalSubtitle: {
        rag: 'Passa il mouse su una cartella per contrassegnarla Includi / Escludi; clicca di nuovo per rimuovere.',
        agent:
          'Puoi arrivare al singolo file; i file seguono la loro cartella per impostazione predefinita.',
      },
      status: {
        rag: {
          all: "Indicizza l'intero vault",
          only: 'Indicizza solo {{items}}',
        },
        agent: {
          all: "L'intero vault è disponibile",
          only: 'Disponibili solo {{items}}',
        },
        excludeSuffix: ', escludendo {{items}}',
        excludeWithinSuffix: ', escludendo {{items}} al suo interno',
        folders: '{{n}} cartelle',
        files: '{{n}} file',
        joiner: ', ',
        estimate: {
          rag: '≈ {{n}} / {{total}} note',
          agent: '{{n}} / {{total}} file raggiungibili',
        },
      },
    },
    rag: {
      title: 'Knowledge base',
      desc: "Gestisci gli indici della knowledge base. Il RAG viene attivato automaticamente quando l'Agent usa lo strumento Ricerca in modalità Ibrida o RAG.",
      embeddingModelDesc:
        'Modello usato per generare embeddings per la ricerca semantica.',
      chunkSize: 'Dimensione chunk',
      chunkSizeDesc: 'Numero di caratteri per chunk di testo.',
      minSimilarity: 'Similarità minima',
      minSimilarityDesc:
        'Punteggio di similarità minimo (0-1) per includere un chunk nei risultati.',
      limit: 'Limite',
      limitDesc: 'Numero massimo di chunk da recuperare.',
      embeddingConcurrency: 'Concorrenza embedding',
      embeddingConcurrencyDesc:
        "Numero massimo di richieste di embedding in parallelo durante l'indicizzazione (1–24, predefinito 10). Riducilo se il provider restituisce errori 429 / limite di frequenza.",
      vectorDataSize: 'Dati vettoriali (MB)',
      inMemoryIndexEstimate: 'Indice in memoria (MB)',
      manage: 'Gestisci',
      advanced: 'Impostazioni avanzate',
      indexPdf: 'Indicizza file PDF',
      indexPdfDesc:
        'Estrae e indicizza il testo dei PDF per la knowledge base. La prima ricostruzione completa può richiedere più tempo; disattiva per vault molto grandi se non ti serve il recupero sui PDF.',
      selectEmbeddingModelFirst:
        "Seleziona prima un modello di embedding, poi attiva l'indicizzazione della knowledge base.",
      waitingRateLimit: 'In attesa del reset del limite di frequenza...',
      preparingProgress: 'Preparazione indicizzazione...',
      cancelIndex: 'Annulla',
      cancellingIndex: 'Annullamento…',
      // Status bar (RAGSection)
      indexingDisabled: "L'indicizzazione della knowledge base è disattivata",
      indexingDisabledSub:
        "Lo strumento Ricerca dell'Agent userà solo la ricerca per parole chiave. Scegli un modello di embedding qui sotto, poi attiva l'indicizzazione.",
      indexingProgress: 'Indicizzazione di {{kb}} in corso',
      indexedCount: '{{n}} documento/i indicizzati',
      autoUpdate: 'Aggiornamento automatico',
      updateNow: 'Aggiorna ora',
      previousRunInterrupted:
        "L'ultima indicizzazione non è terminata correttamente.",
    },
    knowledgeBases: {
      title: 'Knowledge base',
      new: 'Nuova knowledge base',
      emptyState: 'Nessuna knowledge base ancora creata',
      count: '{{n}} knowledge base',
      queuedCount: '{{n}} knowledge base in coda',
      pendingCount: '{{n}} aggiornamento/i in sospeso',
      attentionCount: '{{n}} knowledge base richiedono attenzione',
      embeddingModelLine: 'Modello embedding {{model}}',
      embeddingModelShelf: 'Modello embedding',
      embeddingModelShelfDesc:
        'Condiviso da tutte le knowledge base · cambiarlo richiede una ricostruzione completa',
      embeddingModelApiRow: 'Modello API',
      embeddingModelApiRowMeta:
        '{{dimension}} dim · fatturato per token · chiavi e modelli personalizzati nella scheda Modelli',
      setAsCurrent: 'Imposta come corrente',
      stateReady: 'Pronta',
      stateIndexing: 'In indicizzazione',
      statePending: 'Aggiornamento in sospeso',
      stateQueued: 'In coda',
      stateAttention: 'Richiede attenzione',
      docs: 'Documenti',
      chunks: 'Chunk',
      pendingFiles: '{{n}} file modificati',
      lastUpdated: 'Ultimo aggiornamento {{time}}',
      enableAndIndex: 'Attiva e indicizza',
      disable: 'Disattiva indicizzazione',
      rebuildThis: 'Ricostruisci questa base',
      rebuildAll: 'Ricostruisci tutti gli indici',
      manageDataTitle: 'Gestisci dati indicizzati',
      noIndexedData: 'Nessun indice disponibile',
      manageModelColumn: 'Modello',
      manageEmbeddingsColumn: 'Embedding totali',
      manageActionsColumn: 'Azioni',
      manageRefresh: 'Aggiorna',
      manageRemoveIndex: 'Rimuovi indice',
      removeIndexFailed: "Impossibile rimuovere l'indice",
      localEmbedding: {
        groupLabel: 'Locale',
        groupDesc:
          'Eseguito sul tuo dispositivo: le note non lasciano questo computer.',
        desktopOnly:
          'I modelli di embedding locali sono disponibili solo su desktop.',
        metaLine: '{{dimension}} dim · {{size}}',
        download: 'Scarica',
        downloadingLine: 'Download {{percent}}% · {{received}} / {{total}}',
        verifying: 'Verifica dei file…',
        failedLine: 'Download non riuscito: {{error}}',
        readyLine: 'Scaricato',
        current: 'Attuale',
        viewSource: 'Origine',
        sourceRepoLabel: 'Repository',
        sourceRevisionLabel: 'Revisione',
        sourceFilesLabel: 'File',
        confirmDelete: 'Clicca di nuovo per eliminare',
        endpointLabel: 'Origine download',
        endpointCustomOption: 'Personalizzato',
        endpointCustomPlaceholder: 'https://example.com',
        endpointCustomInvalid: 'Inserisci un indirizzo http/https valido',
        engineModelNotDownloaded: 'Modello di embedding locale non scaricato',
        engineModelNotDownloadedSub:
          "Scarica il modello nelle impostazioni della Knowledge Base per usare l'embedding locale.",
        engineDownloadAction: 'Scarica modello',
        engineModelDownloadingLine:
          'Download del modello di embedding locale {{percent}}%',
        engineModelVerifying:
          'Verifica dei file del modello di embedding locale…',
        engineModelFailedLine:
          'Download del modello di embedding locale non riuscito: {{error}}',
        engineComponentDisabled: 'Il motore di embedding locale è disattivato',
        engineComponentDisabledSub:
          "Attiva il motore di embedding per usare l'embedding locale.",
        engineEnableAction: 'Attiva',
        engineEnableFailed: 'Impossibile attivare il motore di embedding',
        engineComponentFailed:
          'Inizializzazione del motore di embedding locale non riuscita',
        engineComponentPreparing:
          'Il motore di embedding locale si sta preparando…',
        engineNonDesktop: "L'embedding locale non è disponibile",
        engineNonDesktopSub:
          'I modelli di embedding locali funzionano solo su desktop.',
        languageNames: {
          en: 'Inglese',
          zh: 'Cinese',
          multilingual: 'Multilingua',
        },
        dtypeBadge: {
          q8: 'INT8',
          fp16: 'FP16',
        },
      },
      delete: 'Elimina knowledge base',
      deleteConfirm:
        'Verranno eliminati la knowledge base "{{name}}" e tutti i suoi dati indicizzati. L\'operazione non è reversibile.',
      createTitle: 'Nuova knowledge base',
      editTitle: 'Knowledge base · {{name}}',
      fieldName: 'Nome',
      fieldNameDesc: 'Il nome visualizzato di questa knowledge base',
      fieldDescription: 'Descrizione',
      fieldDescriptionDesc:
        'Descrivi cosa contiene principalmente questa base. Questo testo viene fornito al modello per aiutarlo a scegliere la knowledge base giusta da consultare; è facoltativo.',
      fieldDescriptionPlaceholder:
        'Es. Verbali riunioni quotidiane e documenti dei progetti in corso',
      scopeTitle: 'Ambito',
      scopeDesc: 'Decide quali cartelle entrano in questa knowledge base.',
      nameRequired: 'Inserisci un nome per la knowledge base',
      nameDuplicate: 'Esiste già una knowledge base con questo nome',
      saveFailed: 'Impossibile salvare la knowledge base',
      deleteTitle: 'Elimina knowledge base',
      deleteFailed: 'Impossibile eliminare la knowledge base',
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
    editor: {
      snippets: {
        sectionTitle: 'Snippet',
        sectionDesc:
          "Digita / nell'input della chat e scegli uno snippet per inserire un prompt predefinito. Gli snippet sono in YOLO/snippets.md.",
        cardName: 'Libreria snippet',
        cardDescCount: '{count} snippet',
        cardDescMissing: 'Nessun file snippets.md',
        manageBtn: 'Gestisci snippet',
        initBtn: 'Inizializza snippet',
        modalTitle: 'Gestisci snippet',
        modalCallout:
          "Gli snippet sono in YOLO/snippets.md. Attiva l'input della chat con / e selezionane uno per inserire il corpo.",
        openFileBtn: 'Apri snippets.md',
        createFileBtn: 'Crea snippets.md',
        empty: 'Nessuno snippet',
        jumpBtn: 'Modifica',
        deleteBtn: 'Elimina',
        deleteTitle: 'Elimina snippet',
        deleteMessage:
          'Vuoi eliminare lo snippet "{trigger}"? Questa operazione non può essere annullata.',
        deleteConfirm: 'Elimina',
        deleteSuccess: 'Snippet "{trigger}" eliminato',
        deleteError: 'Eliminazione fallita: {error}',
        openError: 'Apertura di snippets.md fallita: {error}',
      },
    },
    continuation: {
      title: 'Sparkle',
      aiSubsectionTitle: 'Continuazione AI',
      tabSubsectionTitle: 'Completamento Tab',
      superContinuation: 'Abilita vista Sparkle',
      superContinuationDesc:
        'Abilita la vista Sparkle nella barra laterale per configurare modelli, parametri, regole e fonti di riferimento dedicati alla continuazione. Se disabilitata, resta disponibile solo la vista Chat.',
      continuationModel: 'Modello di continuazione',
      continuationModelDesc:
        'Seleziona il modello usato per la continuazione in Sparkle.',
      selectionChatSubsectionTitle: 'Cursor chat',
      selectionChatDescription:
        'Offre azioni rapide sul testo selezionato, come chiedere, riscrivere o spiegare.',
      selectionChatToggle: 'Abilita chat selezione',
      selectionChatToggleDesc:
        'Quando attivo, selezionando del testo compaiono azioni rapide per fare domande o usare comandi predefiniti.',
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
      tabCompletionMultipleCandidates: 'Genera più suggerimenti',
      tabCompletionMultipleCandidatesDesc:
        'Quando attivo, genera tre suggerimenti di completamento.',
      tabCompletionModel: 'Modello completamento tab',
      tabCompletionModelDesc:
        'Modello usato per il completamento tab e la regolazione della lunghezza.',
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
      tabCompletionRequestTimeout: 'Timeout richiesta (secondi)',
      tabCompletionRequestTimeoutDesc:
        'Interrompe la richiesta di completamento se supera questo numero di secondi. Aumentalo per modelli più lenti o con ragionamento lungo.',
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
      tabCompletionTriggerAcceptMode: 'Comportamento di accettazione',
      tabCompletionTriggerAcceptModeInsert: 'Inserisci al cursore',
      tabCompletionTriggerAcceptModeReplace:
        'Sostituisci il testo corrispondente',
      tabCompletionTriggerDescription: 'Descrizione',
      tabCompletionTriggerRemove: 'Rimuovi',
    },
    etc: {
      title: 'Altro',
      pluginUpdateNotice: 'Notifiche di aggiornamento',
      pluginUpdateNoticeDesc:
        'Se attivo, YOLO controlla le nuove versioni e te lo segnala.',
      pluginAutoUpdate: 'Scarica aggiornamenti automaticamente',
      pluginAutoUpdateDesc:
        'Se attivo, le nuove versioni rilevate vengono scaricate automaticamente in background.',
      pluginAutoUpdateDescUnavailable:
        'Gli aggiornamenti dei moduli vengono scaricati automaticamente; l’installazione del Core con un clic richiede ancora desktop e una cartella plugin scrivibile.',
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
      clearChatSnapshots: 'Cancella snapshot e cache chat',
      clearChatSnapshotsDesc:
        'Elimina tutti i file snapshot di contesto delle conversazioni, snapshot di revisione modifiche e cache delle altezze della timeline (senza eliminare i messaggi chat).',
      clearChatSnapshotsConfirm:
        'Sei sicuro di voler cancellare tutti i file snapshot e cache della chat? Questa azione non può essere annullata e il contesto e le altezze della timeline potrebbero dover essere ricostruiti in seguito.',
      clearChatSnapshotsSuccess:
        'Tutti i file snapshot e cache della chat sono stati cancellati.',
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
      captureRawRequestDebug: 'Abilita debug richieste LLM',
      captureRawRequestDebugDesc:
        "Quando attivo, ogni risposta del modello mostra un pulsante Debug (nella barra info e nel menu Altre azioni) che consente di consultare o esportare le richieste e risposte raw di LLM, chiamate strumento e ricerche web di quel turno. I dati catturati restano in memoria solo per la sessione corrente di Obsidian e vengono cancellati al riavvio. Le chiavi API sono offuscate nell'export, ma il contenuto originale della conversazione è incluso.",
      yoloBaseDir: 'Cartella base YOLO',
      yoloBaseDirDesc:
        'Inserisci un percorso relativo al vault (senza / iniziale). Esempio: YOLO nella radice del vault, oppure setting/YOLO nella cartella setting. Directory skill attuale: {path}.',
      yoloBaseDirPlaceholder: 'YOLO',
      yoloBaseDirHiddenPath:
        'La cartella base YOLO non può usare cartelle nascoste. Rimuovi il punto iniziale dal nome, ad esempio cambia .yolo in yolo.',
      yoloBaseDirInvalidPath:
        'La cartella base YOLO contiene un nome non supportato su tutti i dispositivi. Evita caratteri di controllo, nomi riservati di Windows e i caratteri <>:"\\|?*.',
      yoloBaseDirMigrated:
        'La cartella base YOLO ora usa {target}, che Obsidian può indicizzare.',
      yoloBaseDirMigrationConflict:
        'La cartella base YOLO non è stata spostata perché {target} esiste già. Le impostazioni esistenti sono state mantenute.',
      yoloBaseDirMigrationFailed:
        'Impossibile migrare la cartella base YOLO. Le impostazioni esistenti sono state mantenute.',
      yoloBaseDirMigrationRollbackFailed:
        'YOLO è stato spostato da {source} a {target}, ma non è stato possibile aggiornare le impostazioni né annullare lo spostamento. Sposta manualmente la cartella in {source} prima di continuare.',
      yoloBaseDirMigrationManualRepair:
        'La cartella base YOLO {source} è nascosta ma non può essere migrata automaticamente in sicurezza. Scegli una cartella visibile e sposta manualmente i file YOLO.',
      yoloBaseDirConflictTitle: 'La cartella base YOLO non è stata spostata',
      yoloBaseDirConflictMessage:
        '{target} esiste già e contiene file. Nessun contenuto è stato spostato per evitare sovrascritture o fusioni. Scegli una cartella vuota o inesistente.',
      ribbonClickAction: 'Icona ribbon apre la chat in',
      ribbonClickActionDesc:
        'Dove l’icona ribbon di YOLO apre la vista Chat. Se nella posizione scelta esiste già una chat viene attivata; altrimenti ne viene creata una nuova.',
      ribbonClickActionSidebar: 'Barra laterale destra',
      ribbonClickActionTab: 'Nuova scheda',
      ribbonClickActionSplit: 'Split destro',
      ribbonClickActionWindow: 'Nuova finestra',
      ribbonClickActionLast: 'Ultima posizione usata',
      enterKeyCreatesNewline: 'Usa Invio per andare a capo',
      enterKeyCreatesNewlineDesc:
        'Si applica ai campi di Chat e Quick Ask. Premi Cmd/Ctrl + Invio per inviare.',
      mentionDisplayMode: 'Posizione visualizzazione mention',
      mentionDisplayModeDesc:
        "Scegli se mostrare i file selezionati con @ e le skill selezionate con / nel testo dell'input o come badge sopra la casella.",
      mentionDisplayModeInline: 'Dentro la casella',
      mentionDisplayModeBadge: 'Badge in alto',
      mentionContextMode: 'Modalita contesto file @',
      mentionContextModeDesc:
        'Controlla come i file con @ vengono iniettati nel modello. In modalita leggera vengono iniettati solo i percorsi dei file citati, le proprieta della nota e la struttura Markdown, incoraggiando l agent a leggere solo il contenuto necessario.',
      mentionContextModeLight: 'Modalita leggera',
      mentionContextModeFull: 'Modalita completa',
      persistSelectionHighlight: 'Mantieni evidenziazione blocco selezione',
      persistSelectionHighlightDesc:
        "Mantiene visibile l'evidenziazione a blocco del contenuto selezionato nell'editor durante l'interazione con la Chat laterale o Quick Ask.",
      chatExportSubsectionTitle: 'Esportazione chat',
      chatExportIncludeThinking: 'Esporta processo di ragionamento',
      chatExportIncludeThinkingDesc:
        'Includi i blocchi di reasoning dell assistant nel markdown esportato.',
      chatExportIncludeToolCalls: 'Esporta chiamate strumento',
      chatExportIncludeToolCallsDesc:
        'Includi argomenti e risultati delle chiamate strumento nel markdown esportato.',
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
      notificationTiming: 'Quando notificare',
      notificationTimingDesc:
        'Scegli se notificare sempre o solo quando Obsidian non è in focus.',
      notificationTimingAlways: 'Notifica sempre',
      notificationTimingWhenUnfocused: 'Solo quando non è in focus',
      notificationApprovalRequired: "Notifica quando serve l'approvazione",
      notificationApprovalRequiredDesc:
        "Avvisa quando YOLO si ferma e richiede l'approvazione per una chiamata strumento.",
      notificationTaskCompleted: 'Notifica al termine del task',
      notificationTaskCompletedDesc:
        "Avvisa quando l'esecuzione corrente di Agent termina senza attendere ulteriori approvazioni.",
      interactionSectionTitle: 'Interazione',
      maintenanceSectionTitle: 'Manutenzione',
    },
  },

  chat: {
    placeholder:
      'Scrivi un messaggio...「@ per aggiungere riferimenti o modelli, / per scegliere una skill o un comando」',
    placeholderCompact: 'Clicca per espandere e modificare...',
    placeholderPrefix: 'Scrivi un messaggio...',
    placeholderMention: 'aggiungere riferimenti o modelli',
    placeholderMentionReferences: 'aggiungere riferimenti',
    placeholderSkill: 'scegliere una skill o un comando',
    contextUsage: 'Utilizzo finestra di contesto',
    contextUsageUnknownMaxSuffix:
      ' (limite finestra di contesto non impostato)',
    contextBreakdown: {
      title: 'Contesto',
      fullLabel: '{{percent}} pieno',
      tokensSuffix: 'token',
      localEstimateCaption:
        'Stima locale — può differire dal conteggio del server.',
      unknownMaxHint:
        'Imposta i token della finestra di contesto nelle impostazioni del modello per vedere la percentuale di utilizzo.',
      error: 'Stima fallita',
      bucket: {
        system: 'Prompt di sistema',
        tools: 'Strumenti',
        rules: 'Regole',
        skills: 'Skill',
        memory: 'Memoria',
        conversation: 'Conversazione',
        reasoning: 'Ragionamento',
      },
    },
    inlineInfo: {
      callsTitle: '{{count}} chiamate in questo turno',
      nextTurnContext: 'Contesto utilizzato: ~{{tokens}} token',
      nextTurnContextCached:
        'Contesto utilizzato: ~{{tokens}} token ({{cached}} in cache)',
    },
    llmDebug: {
      title: 'Dati debug LLM',
      open: 'Apri dati debug LLM',
      openFailed: 'Impossibile aprire i dati di debug',
      copy: 'Copia',
      copied: 'Copiato',
      copyFailed: 'Impossibile copiare i dati di debug',
      save: 'Salva',
      savedShort: 'Salvato',
      saved: 'Dati debug LLM salvati in {{path}}',
      saveFailed: 'Impossibile salvare i dati di debug',
      expired:
        'I dati di debug sono stati cancellati al riavvio (solo sessione corrente)',
    },
    sendMessage: 'Invia messaggio',
    newChat: 'Nuova chat',
    untitledConversation: 'Nuova chat',
    paneTitle: {
      renameAriaLabel: 'Clicca per rinominare la conversazione',
      editingAriaLabel: 'Modifica del titolo della conversazione',
    },
    paneMenu: {
      rename: 'Rinomina',
      deleteConfirmTitle: 'Eliminare la conversazione?',
      deleteConfirmMessage:
        'Questo eliminerà definitivamente "{title}". Questa azione non può essere annullata.',
    },
    continueResponse: 'Continua risposta',
    messageNavigator: {
      title: 'Navigatore messaggi',
      itemAriaLabel: 'Vai al messaggio {index}: {label}',
      emptyMessage: 'Messaggio vuoto',
    },
    mermaidControls: {
      open: 'Apri visualizzatore diagramma',
      zoomOut: 'Riduci',
      zoomIn: 'Ingrandisci',
      fitViewport: 'Adatta alla finestra',
      reset: 'Reimposta zoom',
      controlsLabel: 'Controlli diagramma',
    },
    stopGeneration: 'Ferma generazione',
    queueMessage: {
      tooltip:
        'Metti in coda questo messaggio — verrà inviato al termine del passaggio corrente',
      hint: "In attesa che l'agente completi il passaggio corrente...",
      blockedApproval:
        'Approva o rifiuta lo strumento in attesa prima di inviare un nuovo messaggio.',
      blockedAwaitingInput:
        "Rispondi alla domanda dell'agente nella chat prima di inviare un nuovo messaggio.",
      abortedRestoredOne:
        'Messaggio in coda ripristinato nella casella di input',
      abortedRestoredMany:
        "Ripristinato l'ultimo messaggio in coda nella casella di input ({{count}} scartati)",
    },
    askUserQuestion: {
      title: "L'agente ti pone delle domande",
      submit: 'Invia risposte',
      submitHint: 'Premi Cmd / Ctrl + Invio per inviare',
      cancel: 'Annulla',
      cancelTooltip: 'Ignora le domande e termina questo turno',
      answeredBadge: 'Inviato',
      rejected:
        'Il sistema ha rifiutato la domanda (massimo una ask_user_question per turno, oppure strumento disabilitato).',
      aborted: "Interrotto prima che l'utente potesse rispondere.",
      schemaError:
        "L'agente ha fornito parametri non validi per la domanda: {{error}}",
      stale: 'Questa domanda è scaduta o è già stata gestita.',
      otherOption: 'Altro (specificare)',
      otherPlaceholder: 'Aggiungi la tua risposta…',
      otherAnswerPrefix: 'Altro: ',
      otherAnswerFallback: 'Altro',
      freeTextOptional: 'Facoltativo · lascia vuoto per inviare senza risposta',
    },
    selectModel: 'Seleziona modello',
    uploadImage: 'Carica immagine',
    uploadFile: 'Aggiungi file',
    dropFilesHint: 'Rilascia per aggiungere alla conversazione',
    imageUnsupportedByModel:
      'Questo modello non dichiara il supporto alle immagini. Abilita la modalità di input "Vision" nelle impostazioni del modello per allegare immagini.',
    unsupportedFileType: 'Tipo di file non supportato: {names}',
    processImagesFailed: 'Impossibile elaborare le immagini caricate',
    readPdfFailed: 'Impossibile leggere il PDF "{name}": {error}',
    readOfficeFailed: 'Failed to read Office document "{name}": {error}',
    readTextAttachmentFailed: 'Failed to read text file "{name}": {error}',
    addContext: 'Aggiungi contesto',
    applyChanges: 'Applica modifiche',
    copyMessage: 'Copia messaggio',
    insertAtCursor: 'Inserisci / Sostituisci al cursore',
    insertSuccess: 'Messaggio inserito nella nota attiva',
    insertUnavailable: 'Nessun editor markdown attivo trovato',
    noAssistantContent: 'Nessun contenuto assistente da inserire',
    regenerate: 'Rigenera',
    reasoning: 'Ragionamento',
    reasonedFor: 'Ha ragionato per {{seconds}} s',
    annotations: 'Annotazioni',
    vaultSources: 'Fonti dal vault ({count})',
    pdfReferenceNoPreview: '(PDF: clicca il titolo per aprire la pagina)',
    assistantQuote: {
      add: 'Cita',
      badge: 'Citazione risposta',
      commentPlaceholder: 'Aggiungi un commento…',
      save: 'Salva commento',
      delete: 'Elimina commento',
      inputLabel: 'Annotazione {index}',
    },
    mentionMenu: {
      entryCurrentFile: 'File corrente',
      entryMode: 'Modalita',
      entryAssistant: 'Assistente',
      entryModel: 'Modello',
      entryFile: 'File',
      entryFolder: 'Cartella',
      categoryEmpty: 'Ancora nulla qui',
    },
    slashCommands: {
      compact: {
        label: 'Compatta contesto',
        description:
          'Comprimi manualmente la cronologia precedente e continua il task corrente in una nuova finestra di contesto.',
      },
      openPluginManager: {
        label: 'Gestisci plugin',
        description:
          'Gestisci i plugin di Claude Code installati o installane di nuovi da un marketplace.',
      },
      openMcpServers: {
        label: 'Server MCP',
        description:
          'Visualizza lo stato dei server MCP della sessione corrente.',
      },
    },
    slashMenu: {
      entrySkill: 'Abilità',
      entrySnippet: 'Snippet',
      categoryCommand: 'Comandi',
      categoryEmpty: 'Ancora nulla qui',
      createSnippetsFile: 'Clicca per creare snippets.md',
    },
    emptyState: {
      workspaceTitle: 'Cosa vuoi fare oggi in {vaultName}?',
      askTitle: 'Pensa prima, poi scrivi',
      askDescription:
        "Ideale per domande, revisione e riscrittura, con focus sull'espressione.",
      chatTitle: 'Pensa prima, poi scrivi',
      chatDescription:
        "Ideale per domande, revisione e riscrittura, con focus sull'espressione.",
      agentTitle: "Lascia eseguire all'AI",
      agentDescription:
        'Abilita gli strumenti per ricerca, lettura/scrittura e task multi-step.',
      agentFullTitle: "Lascia eseguire all'AI · Modalità YOLO",
      agentFullDescription:
        'Approva automaticamente gli strumenti per ricerca, lettura/scrittura e task multi-step.',
    },
    cliSurface: {
      emptyTitle: 'Usa CLI Agent',
      emptyDescription:
        'Collega Claude Code o Codex per eseguire attività complesse su questo dispositivo.',
      emptyUserMessage: 'Messaggio vuoto',
      error: 'Errore della sessione CLI: {message}',
      runtimeError: 'Impossibile avviare il runtime CLI: {message}',
      submitError: 'Impossibile inviare il messaggio CLI: {message}',
      cancelError: 'Impossibile interrompere la CLI: {message}',
      openError: 'Impossibile aprire la sessione CLI: {message}',
      transitionError:
        'Impossibile lasciare la sessione CLI corrente: {message}',
      sessionFallbackDividerTitle: 'Passato al profilo predefinito',
      sessionFallbackDividerDescription:
        'L\'agente originale "{profile}" non è disponibile, quindi questa conversazione è passata al profilo predefinito: i messaggi precedenti non fanno parte della sua memoria.',
      sessionFallbackUnknownProfile: 'precedente',
    },
    hermesProfileSelector: {
      accessibleLabel: 'Profilo Hermes: {profile}',
    },
    cliControls: {
      defaultModel: 'Modello predefinito di {provider}',
      loadError: 'Impossibile caricare i modelli CLI: {message}',
      updateError: 'Impossibile aggiornare la configurazione CLI: {message}',
    },
    claudePlugins: {
      title: 'Gestisci plugin',
      placeholder: 'Caricamento informazioni sui plugin…',
      tabInstalled: 'Installati',
      tabBrowse: 'Sfoglia',
      loadError: 'Impossibile caricare le informazioni sui plugin.',
      cliFallback:
        'Operazione plugin non riuscita. Gestisci i plugin dal terminale con claude plugin.',
      updateRestartRequired:
        'Plugin aggiornato. Avvia una nuova sessione perché la modifica abbia effetto.',
      installedEmpty: 'Nessun plugin installato.',
      browseEmpty: 'Nessun plugin corrispondente trovato.',
      searchPlaceholder: 'Cerca plugin…',
      update: 'Aggiorna',
      uninstall: 'Disinstalla',
      install: 'Installa',
      installedBadge: 'Installato',
      uninstallConfirmTitle: 'Disinstalla plugin',
      uninstallConfirmMessage:
        'Disinstallare "{name}"? Questa azione non può essere annullata.',
      scopeUser: 'Utente',
      scopeProject: 'Progetto',
      scopeLocal: 'Locale',
      installCount: '{count} installazioni',
    },
    mcpServers: {
      title: 'Server MCP',
      placeholder: 'Caricamento stato dei server MCP…',
      refresh: 'Aggiorna',
      reconnect: 'Riconnetti',
      toolCount: '{count} strumenti',
      statusConnected: 'Connesso',
      statusFailed: 'Connessione non riuscita',
      statusNeedsAuth: 'Accesso richiesto',
      statusPending: 'Connessione in corso',
      statusDisabled: 'Disattivato',
      statusUnknown: 'Stato sconosciuto',
      empty: 'Nessun server MCP configurato per questa sessione.',
      loadError: 'Impossibile caricare lo stato dei server MCP.',
      noActiveSession:
        'Nessuna sessione attiva. Invia un messaggio per avviare una sessione CLI.',
      actionError: 'Operazione non riuscita: {error}',
      runtimeSwitched:
        'Il runtime è cambiato, quindi questa azione è stata annullata.',
      codexReadOnlyNote:
        'Lo stato dei server MCP di Codex è di sola lettura qui. Gestisci i server dal terminale.',
      codexUnsupportedVersion:
        'Questa versione di Codex CLI non supporta la query dello stato dei server MCP. Aggiorna Codex CLI.',
    },
    quickAccess: {
      manage: 'Gestisci accessi rapidi',
      searchPlaceholder: 'Cerca skill o comandi rapidi',
      skills: 'Skill',
      snippets: 'Comandi rapidi',
      empty: 'Nessun risultato',
    },
    compaction: {
      pendingTitle: 'Compattazione del contesto in corso',
      dividerTitle: "Da qui continua l'attivita corrente",
      dividerDescription:
        'La conversazione precedente e stata compressa in un riassunto. Le risposte seguenti continuano da quel riassunto',
      dividerDescriptionWithEstimate:
        'La conversazione precedente e stata compressa in un riassunto. Il contesto totale del turno successivo e stimato intorno a {count} token',
      dividerDescriptionWithSavings:
        '{messageCount} messaggi compressi, risparmiati circa {tokens} token',
      pendingStatus:
        'Sto riorganizzando il contesto. La conversazione continuera tra poco in un nuovo contesto.',
      success:
        'Il contesto precedente e stato compresso. Le prossime risposte continueranno dal riassunto.',
      failed: 'Compattazione del contesto non riuscita. Riprova tra poco.',
      empty: 'Non ci sono ancora contenuti di conversazione da comprimere.',
      runActive:
        'Attendi che la risposta corrente finisca prima di compattare il contesto.',
      waitingApproval:
        "Gestisci prima l'approvazione dello strumento in sospeso, poi compatta il contesto.",
      autoFailed:
        'Compattazione automatica non riuscita. Invio con il contesto precedente.',
    },
    todoPanel: {
      summaryPlanning: '{count} attivita da iniziare',
      summaryInProgress: 'Passo {index}/{total}: {text}',
      summaryPartial: '{done}/{total} completate',
      summaryAllDone: 'Tutte {total} completate',
      expand: 'Espandi',
      collapse: 'Comprimi',
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
    customRewritePromptPlaceholder:
      'Descrivi come riscrivere il testo selezionato, ad es. "rendi conciso e voce attiva; mantieni la struttura markdown"; premi shift+invio per confermare, invio per una nuova riga, ed esc per chiudere.',
    customContinueProcessing: 'Elaborazione...',
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
    editSummary: {
      filesChanged: '{count} file modificati',
      operationCreate: 'Creato',
      operationDelete: 'Eliminato',
      undo: 'Annulla',
      undoFile: 'Annulla modifica file',
      undone: 'Annullato',
      undoSuccess:
        "Le modifiche ai file di questo turno dell'assistente sono state annullate.",
      undoPartial:
        'Alcuni file sono stati ripristinati, mentre altri sono stati saltati per modifiche successive.',
      undoUnavailable:
        'Il contenuto dei file e cambiato e questo turno non puo essere annullato in sicurezza.',
      undoFailed: 'Annullamento non riuscito. Riprova.',
      fileDeleted:
        'Questo file e stato eliminato. Usa annulla per ripristinarlo.',
      fileMissing: 'Il file non esiste piu o e stato spostato.',
    },
    errorCard: {
      title: 'Questa risposta non e stata generata',
      connectionInterruptedContinuable:
        'La connessione al servizio del modello si e interrotta. La risposta parziale e ancora disponibile: fai clic su Continua risposta per riprendere.',
      viewDetails: 'Mostra dettagli errore',
      hideDetails: 'Nascondi dettagli errore',
      goToSettings: 'Vai alle impostazioni',
      diagnosis: {
        auth: 'La chiave API non e valida. Controllala e riconfigura il provider.',
        region:
          'Il servizio non e disponibile nella tua area. Configura un proxy o passa a un provider disponibile.',
        model: 'Il modello non esiste o non hai i permessi per accedervi.',
        quota:
          'Il credito dell account e esaurito. Ricarica o passa a un altro provider.',
        rateLimit:
          'Troppe richieste in poco tempo. Attendi un momento e riprova, oppure passa a un modello con limiti piu alti.',
        contextLength:
          'Il contesto della conversazione e troppo lungo. Elimina i messaggi precedenti o avvia una nuova chat.',
        payload: 'La richiesta e troppo grande. Invia meno file o meno testo.',
        content:
          'Il contenuto e stato bloccato da un sistema di sicurezza. Modificalo e riprova.',
        mcp: 'Impossibile raggiungere il server MCP. Verifica che sia in esecuzione.',
        stream:
          'La trasmissione della risposta si e interrotta. Controlla la stabilita della rete o riprova.',
        network:
          'Impossibile raggiungere il server. Controlla la rete o le impostazioni del proxy.',
        proxy:
          'Errore di proxy o certificato SSL. Controlla le impostazioni di proxy e rete.',
        server: 'Il servizio del modello ha un problema. Riprova piu tardi.',
        deprecated:
          'Questo modello e stato ritirato o deprecato. Passa a un altro modello.',
        knowledge: 'Vettorizzazione della base di conoscenza non riuscita.',
        parse:
          'Il modello ha restituito una risposta non valida. Riprova o cambia modello.',
      },
      responseFormat: {
        responseNotObject:
          'Il servizio modello ha restituito una risposta che non e un oggetto (valore effettivo: {{actual}}).',
        missingChoices:
          'Il servizio modello ha restituito un formato non analizzabile: array choices mancante.',
        invalidChoices:
          'Il servizio modello ha restituito un formato non analizzabile: choices non e un array (valore effettivo: {{actual}}).',
        stage: 'Fase: {{stage}}',
        expected: 'Campo atteso: {{field}}',
        expectedChoicesArray: 'array choices',
        responseFields: 'Campi risposta: {{fields}}',
        upstreamError: 'Errore upstream: {{message}}',
        errorType: 'Tipo errore: {{type}}',
        errorCode: 'Codice errore: {{code}}',
        upstreamMessage: 'Messaggio upstream: {{message}}',
        responsePreview: 'Anteprima risposta: {{preview}}',
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
        completed: 'Completato',
        aborted: 'Interrotto',
        awaitingUserInput: 'In attesa',
        unknown: 'Sconosciuto',
      },
      displayName: {
        fs_read: 'Leggi file',
        fs_edit: 'Modifica testo',
        fs_edit_ops: 'Set modifica file',
        bash: 'Bash',
        memory_add: 'Aggiungi memoria',
        memory_update: 'Aggiorna memoria',
        memory_delete: 'Elimina memoria',
        open_skill: 'Apri skill',
      },
      dangerousBash: {
        title: 'Operazione pericolosa da confermare',
        rmSummary: 'Sto per eliminare i seguenti percorsi (nel cestino):',
        mvSummary: 'Sto per spostare/rinominare i seguenti percorsi:',
      },
      writeAction: {
        write: 'Scrivi file',
      },
      readMode: {
        full: 'Intero testo',
        linesSuffix: ' righe',
        pagesSuffix: ' pagine',
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
      rejectionReason: 'Motivo del rifiuto',
      allow: 'Consenti',
      reject: 'Rifiuta',
      abort: 'Interrompi',
      alwaysAllowThisTool: 'Consenti sempre questo strumento',
      allowForThisChat: 'Consenti per questa chat',
      approvePlan: 'Approva il piano',
      stayInPlan: 'Resta in modalità piano',
    },
    toolSummary: {
      todoWrite: {
        cleared: 'Elenco svuotato',
        allCompleted: 'Tutte completate ({count})',
        created: 'Pianificate {count} attivita',
        progress: 'Avanzamento {done}/{total}',
      },
      terminalCommand: {
        sessionPoll: 'Sessione {id} · Poll',
        sessionKill: 'Sessione {id} · Termina',
        sessionInput: 'Sessione {id} · Input: {preview}',
      },
    },
    toolRunSummary: {
      read: 'Letti {count} file',
      search: 'Eseguite {count} ricerche',
      web: '{count} ricerche web',
      edit: 'Modificati {count} file',
      editedFile: 'Modificato {name}',
      createdFile: 'Creato {name}',
      deletedFile: 'Eliminato {name}',
      virtualTerminal: 'Terminale virtuale {count} volte',
      terminal: 'Terminale {count} volte',
      command: 'Eseguiti {count} comandi',
      analysis: '{count} analisi in sandbox',
      other: '{count} altre azioni',
    },
    liveTask: {
      statusRunning: 'In esecuzione',
      statusDone: 'Completato',
      statusAborted: 'Interrotto',
      statusError: 'Errore',
      progress: 'Avanzamento',
      output: 'Output',
      activity: 'Attività',
      abortedBeforeOutput: 'Interrotto prima di produrre output.',
      noActivity: 'Nessuna attività.',
      progressTruncated: 'Avanzamento troncato.',
      truncated: 'Output troncato.',
    },
    subagent: {
      defaultTitle: 'Subagent',
      openDetails: 'Visualizza dettagli subagent',
      loadingActivity: 'Caricamento attività…',
      planningNextMoves: 'Pianificazione prossimi passi',
      noActivity: 'Nessuna attività.',
      statusCompleted: 'Completato',
      statusAborted: 'Interrotto',
      statusFailed: 'Fallito',
      statusDispatched: 'Inviato',
      toolUseCount: '{count} strumenti',
      tokenCount: '{count} token',
      approval: {
        heading: 'In attesa di approvazione',
        headingMulti: 'In attesa di approvazione · {count}',
        approve: 'Approva',
        reject: 'Rifiuta',
        approveAll: 'Approva tutto',
        rejectAll: 'Rifiuta tutto',
        viewDetails: 'Vedi parametri',
      },
    },
    conversationSettings: {
      openAria: 'Impostazioni conversazione',
      chatMemory: 'Memoria chat',
      maxContext: 'Contesto massimo',
      sampling: 'Parametri di campionamento',
      temperature: 'Temperatura',
      topP: 'Top p',
      streaming: 'Streaming',
      geminiTools: 'Strumenti Gemini',
      webSearch: 'Ricerca web',
      urlContext: 'Contesto URL',
    },
    notification: {
      approvalTitle: 'YOLO richiede la tua conferma',
      approvalBody:
        'Il task corrente è in pausa e attende la tua approvazione per una chiamata strumento.',
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
    indexedWithSkipped: 'Indice completato · {{count}} file non indicizzabili.',
    continueComplete: 'Indicizzazione ripresa completata.',
    continueFailed: 'Indicizzazione ripresa fallita.',
    openYoloNewChatFailed:
      'Impossibile aprire la finestra chat YOLO; prova prima dal palette comandi.',
    updatingIndex: 'Aggiornamento indice vault in corso…',
    indexUpdated: 'Indice vault aggiornato.',
    indexUpdateFailed: 'Aggiornamento indice vault fallito.',
    migrationComplete: 'Migrazione a storage JSON completata con successo.',
    migrationFailed:
      'Migrazione a storage JSON fallita; controlla la console per i dettagli.',
    reloadingPlugin: 'Ricaricamento "next-composer" a causa della migrazione',
    settingsInvalid: 'Impostazioni non valide',
    transportModeAutoPromoted:
      'Rilevato un problema di rete/CORS. Questo provider e stato impostato automaticamente su {mode}.',
    capturePdfNoLeaf: 'Nessun file PDF aperto al momento.',
    capturePdfFailed: 'Impossibile catturare la regione selezionata.',
    capturePdfInjectFailed: 'Impossibile aggiungere lo screenshot alla chat.',
  },

  pdf: {
    regionSelectorHint:
      'Trascina per selezionare una regione. Premi ESC per annullare.',
    toolbarButtonTooltip: 'Cattura regione PDF nella chat',
  },

  mentionable: {
    pdfPage: 'Pagina {{page}}',
  },

  statusBar: {
    agentRunningWithApproval:
      'Al momento ci sono {count} agent in esecuzione ({approvalCount} in attesa di approvazione)',
    agentRunning: 'Al momento ci sono {count} agent in esecuzione',
    agentStatusAriaLabel:
      'Stato Agent, clicca per vedere le conversazioni in esecuzione',
    agentStatusTitle:
      'Clicca per vedere le conversazioni in esecuzione e aprirne una in una nuova scheda chat',
    agentStatusPanelTitle: 'Conversazioni Agent attive',
    agentStatusPanelEmpty: 'Non ci sono conversazioni in esecuzione da aprire',
    agentStatusRunning: 'In esecuzione',
    agentStatusWaitingApproval: 'In attesa di approvazione',
    agentStatusFallbackConversationTitle: 'Conversazione in esecuzione',
    cliStatusRunning: 'In esecuzione',
    cliStatusWaitingApproval: 'In attesa di approvazione',
    cliStatusWaitingUser: 'In attesa di input',
    backgroundStatusPanelTitle: 'Attivita e promemoria',
    backgroundStatusPanelEmpty: 'Non ci sono attivita o promemoria',
    backgroundTasksRunning:
      'Al momento ci sono {count} attivita in background in esecuzione',
    backgroundTasksNeedAttention:
      "Un'attivita in background richiede attenzione",
    ragAutoUpdateRunning: 'La knowledge base si sta aggiornando in background',
    ragAutoUpdateRunningDetail:
      "Sincronizzazione incrementale dell'indice della knowledge base in corso.",
    ragAutoUpdateFailed:
      'Aggiornamento automatico della knowledge base non riuscito',
    ragAutoUpdateFailedDetail:
      "L'ultima sincronizzazione in background non e riuscita. Riprova piu tardi.",
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
    reviewTitle: 'Rivedi modifiche',
    changesResolved: 'modifiche risolte',
    acceptAllIncoming: 'Accetta tutte in arrivo',
    acceptAllChanges: 'Accetta tutte le modifiche',
    keepAllChanges: 'Mantieni tutto',
    rejectAll: 'Rifiuta tutte',
    rejectAllChanges: 'Rifiuta tutte le modifiche',
    revertAllChanges: 'Ripristina tutto',
    prevChange: 'Modifica precedente',
    nextChange: 'Modifica successiva',
    reset: 'Ripristina',
    applyAndClose: 'Applica e chiudi',
    acceptIncoming: 'Accetta in arrivo',
    acceptChange: 'Accetta modifica',
    keepChange: 'Mantieni questa modifica',
    acceptCurrent: 'Accetta corrente',
    rejectChange: 'Rifiuta modifica',
    revertChange: 'Ripristina questa modifica',
    acceptBoth: 'Accetta entrambe',
    acceptedIncoming: 'In arrivo accettata',
    keptChange: 'Modifica mantenuta',
    keptCurrent: 'Corrente mantenuta',
    revertedChange: 'Modifica ripristinata',
    mergedBoth: 'Entrambe unite',
    undo: 'Annulla',
  },

  quickAsk: {
    selectAssistant: 'Seleziona un assistente',
    noAssistant: 'Nessun assistente',
    noAssistantDescription: 'Usa prompt di sistema predefinito',
    navigationHint: '↑↓ per navigare, Invio per selezionare, Esc per annullare',
    inputPlaceholder: 'Fai una domanda...',
    continuePlaceholder:
      'Lascia vuoto per continuare a scrivere, oppure aggiungi istruzioni...',
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
    rewriteSelectionExpired:
      'La selezione non è più disponibile. Seleziona nuovamente il testo.',
    editPartialSuccess:
      'Applicate {appliedCount} di {totalEdits} modifiche. Controlla la console per i dettagli.',
    statusRequesting: 'Richiesta in corso...',
    statusThinking: 'Sto pensando...',
    statusGenerating: 'Sto generando...',
  },

  chatMode: {
    ask: 'Ask',
    askDesc: 'Chiedi, rifinisci, crea',
    chat: 'Chat',
    chatDesc: 'Chiedi, rifinisci, crea',
    rewrite: 'Riscrivi',
    rewriteDesc: 'Modifica solo la selezione corrente',
    agent: 'Agent',
    agentDesc: 'Strumenti per task complessi',
    continue: 'Scrivi',
    continueDesc: 'Continua a scrivere al cursore, premi Tab per accettare',
    agentFull: 'Agent (YOLO)',
    agentFullDesc:
      'Approva automaticamente le chiamate agli strumenti per task complessi',
    yolo: 'YOLO',
    yoloDesc:
      'Approva automaticamente le chiamate agli strumenti per task complessi',
    fullAccessWarning: {
      title: 'Conferma prima di abilitare la Modalità YOLO',
      description:
        'La Modalità YOLO approva automaticamente tutte le chiamate agli strumenti, incluse modifiche ai file e comandi terminal. Prima di continuare, leggi i seguenti rischi:',
      permission:
        'Gli strumenti vengono eseguiti senza approvazione per chiamata. I prefissi di comandi pericolosi restano bloccati.',
      cost: 'Le esecuzioni autonome possono consumare molte risorse del modello e comportare costi piu elevati.',
      backup:
        'Esegui un backup dei contenuti importanti in anticipo per evitare modifiche indesiderate.',
      checkbox:
        'Ho compreso i rischi sopra indicati e accetto la responsabilita di procedere',
      cancel: 'Annulla',
      confirm: 'Continua con Modalità YOLO',
    },
  },

  reasoning: {
    selectReasoning: 'Seleziona ragionamento',
    effort: 'Sforzo',
    faster: 'Più veloce',
    smarter: 'Più intelligente',
    off: 'Off',
    on: 'On',
    auto: 'Auto',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max',
    offDesc: 'Nessun ragionamento, risponde direttamente',
    autoDesc: 'Il modello decide la profondità del ragionamento',
    lowDesc: 'Ragionamento leggero, risposta più rapida',
    mediumDesc: 'Profondità di ragionamento bilanciata',
    highDesc: 'Ragionamento approfondito, per problemi complessi',
    xhighDesc: 'Ragionamento esteso per le attività più impegnative',
    maxDesc: 'Ragionamento massimo per le attività più impegnative',
  },

  update: {
    newVersionAvailable: 'Nuova versione {version} disponibile',
    toastTitle: 'YOLO · Nuova versione',
    currentVersion: 'Attuale',
    viewDetails: 'Controlla aggiornamenti',
    goUpdate: 'Aggiorna',
    dismiss: 'Chiudi',
    languageEnglish: 'EN',
    languageChinese: '中文',
    viewHistory: 'Visualizza cronologia aggiornamenti',
    skipVersion: 'Non ricordarmelo per questa versione',
    historyTitle: 'Cronologia aggiornamenti',
    historyLoading: 'Caricamento cronologia aggiornamenti...',
    historyError:
      'Impossibile caricare la cronologia aggiornamenti. Riprova più tardi.',
    historyEmpty: 'Nessuna cronologia aggiornamenti trovata.',
    historyPage: 'Pagina {{current}}',
    historyPrev: 'Precedente',
    historyNext: 'Successiva',
    installationIncompleteTitle: 'Installazione del plugin incompleta',
    installationIncompleteMeta:
      'main.js {mainVersion} · manifest {manifestVersion} · styles {stylesVersion}',
    installationIncompleteSuspects: 'File da riparare: {files}',
    installationIncompleteNotes:
      'I file del plugin potrebbero non essere stati scaricati completamente. La riparazione parte automaticamente; puoi anche riprovare qui sotto.',
    tryRepair: 'Prova a riparare',
    repairing: 'Riparazione {{progress}}%',
    repairAndReload: 'Ripara e ricarica',
    downloadUpdate: 'Scarica aggiornamento',
    downloading: 'Download {{progress}}%',
    backgroundDownloading: 'Download in background…',
    installAndReload: 'Installa e ricarica',
    applying: 'Installazione…',
    downloadFailed: 'Download non riuscito',
    installFailed: 'Installazione non riuscita',
    viewOnGitHub: 'Vedi su GitHub',
    updateInCommunityPlugins: 'Aggiorna dai plugin community',
    manualInstallOnGitHub:
      'Non riesci ad aggiornare? Installa manualmente da GitHub',
  },
}
