export type Language = 'en' | 'zh' | 'it'

export type TranslationKeys = {
  // Commands
  commands: {
    openChat: string
    addSelectionToChat: string
    addFileToChat: string
    addFolderToChat: string
    rebuildVaultIndex: string
    updateVaultIndex: string
    continueWriting: string
    continueWritingSelected: string
    customContinueWriting: string
    customRewrite: string
  }

  // UI Common
  common: {
    save: string
    cancel: string
    delete: string
    edit: string
    add: string
    clear: string
    remove: string
    confirm: string
    close: string
    loading: string
    error: string
    success: string
    warning: string
    retry: string
    copy: string
    paste: string
    // additions
    default?: string
    on?: string
    off?: string
    noResults?: string
  }

  sidebar?: {
    tabs: {
      chat: string
      composer: string
    }
    composer: {
      title: string
      subtitle: string
      backToChat: string
      modelSectionTitle: string
      continuationModel: string
      continuationModelDesc: string
      contextSectionTitle: string
      ragToggle: string
      ragToggleDesc: string
      sections?: {
        modelWithPrompt?: {
          title: string
        }
        model?: {
          title?: string
          desc?: string
        }
        parameters?: {
          title: string
          desc: string
        }
        context?: {
          title: string
          desc: string
        }
      }
      continuationPrompt?: string
      maxContinuationChars?: string
      referenceRulesTitle?: string
      referenceRulesPlaceholder?: string
      knowledgeBaseTitle?: string
      knowledgeBasePlaceholder?: string
      knowledgeBaseHint?: string
    }
  }

  // Smart Space UI
  smartSpace?: {
    webSearch?: string
    urlContext?: string
    mentionContextLabel?: string
  }

  // Settings
  settings: {
    title: string
    supportSmartComposer: {
      name: string
      desc: string
      buyMeACoffee: string
    }
    defaults: {
      title: string
      defaultChatModel: string
      defaultChatModelDesc: string
      toolModel: string
      toolModelDesc: string
      globalSystemPrompt: string
      globalSystemPromptDesc: string
      continuationSystemPrompt: string
      continuationSystemPromptDesc: string
      chatTitlePrompt: string
      chatTitlePromptDesc: string
      baseModelSpecialPrompt?: string
      baseModelSpecialPromptDesc?: string
      tabCompletionSystemPrompt?: string
      tabCompletionSystemPromptDesc?: string
    }
    chatPreferences: {
      title: string
      includeCurrentFile: string
      includeCurrentFileDesc: string
      enableTools: string
      enableToolsDesc: string
      maxAutoIterations: string
      maxAutoIterationsDesc: string
      maxContextMessages: string
      maxContextMessagesDesc: string
      defaultTemperature?: string
      defaultTemperatureDesc?: string
      defaultTopP?: string
      defaultTopPDesc?: string
    }
    assistants: {
      title: string
      desc: string
      addAssistant: string
      noAssistants: string
      // existing optional keys in locales
      editAssistant?: string
      deleteAssistant?: string
      noAssistant?: string
      selectAssistant?: string
      name?: string
      nameDesc?: string
      description?: string
      descriptionDesc?: string
      descriptionPlaceholder?: string
      systemPrompt?: string
      actions?: string
      // new optional helpers
      namePlaceholder?: string
      systemPromptDesc?: string
      systemPromptPlaceholder?: string
      defaultAssistantName?: string
      // Confirm modal & aria
      deleteConfirmTitle?: string
      deleteConfirmMessagePrefix?: string
      deleteConfirmMessageSuffix?: string
      addAssistantAria?: string
      deleteAssistantAria?: string
      dragHandleAria?: string
      maxContextMessagesDesc?: string
      duplicate?: string
      copySuffix?: string
      currentBadge?: string
    }
    providers: {
      title: string
      desc: string
      howToGetApiKeys: string
      addProvider: string
      editProvider: string
      editProviderTitle: string
      deleteProvider: string
      deleteConfirm: string
      deleteWarning: string
      chatModels: string
      embeddingModels: string
      embeddingsWillBeDeleted: string
      addCustomProvider: string
      providerId: string
      providerIdDesc: string
      providerIdPlaceholder: string
      apiKey: string
      apiKeyDesc: string
      apiKeyPlaceholder: string
      baseUrl: string
      baseUrlDesc: string
      baseUrlPlaceholder: string
      noStainlessHeaders: string
      noStainlessHeadersDesc: string
    }
    models: {
      title: string
      chatModels: string
      embeddingModels: string
      addChatModel: string
      addEmbeddingModel: string
      addCustomChatModel: string
      addCustomEmbeddingModel: string
      editChatModel: string
      editEmbeddingModel: string
      editCustomChatModel: string
      editCustomEmbeddingModel: string
      modelId: string
      modelIdDesc: string
      modelIdPlaceholder: string
      modelName: string
      modelNamePlaceholder: string
      // auto-fetched models helper labels
      availableModelsAuto?: string
      searchModels?: string
      fetchModelsFailed?: string
      embeddingModelsFirst?: string
      // reasoning UI
      reasoningType?: string
      reasoningTypeNone?: string
      reasoningTypeOpenAI?: string
      reasoningTypeGemini?: string
      reasoningTypeBase?: string
      baseModelWarning?: string
      openaiReasoningEffort?: string
      openaiReasoningEffortDesc?: string
      geminiThinkingBudget?: string
      geminiThinkingBudgetDesc?: string
      geminiThinkingBudgetPlaceholder?: string
      toolType?: string
      toolTypeDesc?: string
      toolTypeNone?: string
      toolTypeGemini?: string
      customParameters?: string
      customParametersDesc?: string
      customParametersAdd?: string
      customParametersKeyPlaceholder?: string
      customParametersValuePlaceholder?: string
      dimension: string
      dimensionDesc: string
      dimensionPlaceholder: string
      noChatModelsConfigured: string
      noEmbeddingModelsConfigured: string
    }
    rag: {
      title: string
      enableRag: string
      enableRagDesc: string
      embeddingModel: string
      embeddingModelDesc: string
      chunkSize: string
      chunkSizeDesc: string
      thresholdTokens: string
      thresholdTokensDesc: string
      minSimilarity: string
      minSimilarityDesc: string
      limit: string
      limitDesc: string
      includePatterns: string
      includePatternsDesc: string
      excludePatterns: string
      excludePatternsDesc: string
      testPatterns: string
      manageEmbeddingDatabase: string
      manage: string
      rebuildIndex: string
      // UI additions
      selectedFolders?: string
      excludedFolders?: string
      selectFoldersPlaceholder?: string
      selectFilesOrFoldersPlaceholder?: string
      selectExcludeFoldersPlaceholder?: string
      conflictNoteDefaultInclude?: string
      conflictExact?: string
      conflictParentExclude?: string
      conflictChildExclude?: string
      conflictRule?: string
      // Auto update additions
      autoUpdate?: string
      autoUpdateDesc?: string
      autoUpdateInterval?: string
      autoUpdateIntervalDesc?: string
      manualUpdateNow?: string
      manualUpdateNowDesc?: string
      // Index progress header/status
      indexProgressTitle?: string
      indexing?: string
      notStarted?: string
    }
    mcp: {
      title: string
      desc: string
      warning: string
      notSupportedOnMobile: string
      mcpServers: string
      addServer: string
      serverName: string
      command: string
      server: string
      status: string
      enabled: string
      actions: string
      noServersFound: string
      tools: string
      error: string
      connected: string
      connecting: string
      disconnected: string
      autoExecute: string
      deleteServer: string
      deleteServerConfirm: string
      edit: string
      delete: string
      expand: string
      collapse: string
      validParameters?: string
      failedToAddServer?: string
      failedToDeleteServer?: string
    }
    templates: {
      title: string
      desc: string
      howToUse: string
      savedTemplates: string
      addTemplate: string
      templateName: string
      noTemplates: string
      loading: string
      deleteTemplate: string
      deleteTemplateConfirm: string
      editTemplate: string
      name: string
      actions: string
    }
    continuation: {
      title: string
      aiSubsectionTitle: string
      customSubsectionTitle: string
      tabSubsectionTitle: string
      superContinuation: string
      superContinuationDesc: string
      continuationModel: string
      continuationModelDesc: string
      smartSpaceDescription: string
      smartSpaceToggle: string
      smartSpaceToggleDesc: string
      smartSpaceTriggerMode: string
      smartSpaceTriggerModeDesc: string
      smartSpaceTriggerModeSingle: string
      smartSpaceTriggerModeDouble: string
      smartSpaceTriggerModeOff: string
      selectionChatToggle: string
      selectionChatToggleDesc: string
      keywordTrigger: string
      keywordTriggerDesc: string
      triggerKeyword: string
      triggerKeywordDesc: string
      // Quick Ask settings
      quickAskSubsectionTitle?: string
      quickAskDescription?: string
      quickAskToggle?: string
      quickAskToggleDesc?: string
      quickAskTrigger?: string
      quickAskTriggerDesc?: string
      // Tab completion settings
      tabCompletion: string
      tabCompletionDesc: string
      tabCompletionModel: string
      tabCompletionModelDesc: string
      tabCompletionTriggerDelay: string
      tabCompletionTriggerDelayDesc: string
      tabCompletionMinContextLength: string
      tabCompletionMinContextLengthDesc: string
      tabCompletionMaxContextChars: string
      tabCompletionMaxContextCharsDesc: string
      tabCompletionMaxSuggestionLength: string
      tabCompletionMaxSuggestionLengthDesc: string
      tabCompletionMaxTokens: string
      tabCompletionMaxTokensDesc: string
      tabCompletionTemperature: string
      tabCompletionTemperatureDesc: string
      tabCompletionRequestTimeout: string
      tabCompletionRequestTimeoutDesc: string
      tabCompletionMaxRetries: string
      tabCompletionMaxRetriesDesc: string
    }
    etc: {
      title: string
      resetSettings: string
      resetSettingsDesc: string
      resetSettingsConfirm: string
      resetSettingsSuccess: string
      reset: string
      // new actions
      clearChatHistory?: string
      clearChatHistoryDesc?: string
      clearChatHistoryConfirm?: string
      clearChatHistorySuccess?: string
      resetProviders?: string
      resetProvidersDesc?: string
      resetProvidersConfirm?: string
      resetProvidersSuccess?: string
    }
    smartSpace?: {
      quickActionsTitle: string
      quickActionsDesc: string
      addAction: string
      resetToDefault: string
      confirmReset: string
      actionLabel: string
      actionLabelDesc: string
      actionLabelPlaceholder: string
      actionInstruction: string
      actionInstructionDesc: string
      actionInstructionPlaceholder: string
      actionCategory: string
      actionCategoryDesc: string
      actionIcon: string
      actionIconDesc: string
      actionEnabled: string
      actionEnabledDesc: string
      moveUp: string
      moveDown: string
      duplicate: string
      disabled: string
      categories?: {
        suggestions: string
        writing: string
        thinking: string
        custom: string
      }
      iconLabels?: {
        sparkles: string
        file: string
        todo: string
        workflow: string
        table: string
        pen: string
        lightbulb: string
        brain: string
        message: string
        settings: string
      }
      copySuffix?: string
      dragHandleAria?: string
    }
    // Modular System Prompt
    systemPrompt?: {
      title: string
      desc?: string
      modularMode: string
      previewMode: string
      addGroup: string
      addPrompt: string
      defaultGroupName: string
      defaultPromptName: string
      defaultPromptContent: string
      groupNamePlaceholder: string
      promptNamePlaceholder: string
      promptContentPlaceholder: string
      editPrompt: string
      editGroupName: string
      editPromptName: string
      editPromptContent: string
      editingTips: string
      tip1: string
      tip2: string
      tip3: string
      tip4: string
      wordCount: string
      charCount: string
      reset: string
      confirmResetContent: string
      confirmDiscardChanges: string
      confirmDeleteGroup: string
      confirmDeletePrompt: string
      deleteGroup: string
      deletePrompt: string
      enabledPrompts: string
      noPrompts: string
      enableGroup: string
      disableGroup: string
      enablePrompt: string
      disablePrompt: string
      // Table headers
      promptName?: string
      enable?: string
      actions?: string
    }
    // System Prompt Preview
    systemPreview?: {
      title: string
      previewContent: string
      previewDesc: string
      previewEmpty: string
      copyToClipboard: string
      copied: string
      previewTip: string
      totalChars: string
      totalWords: string
      totalLines: string
      chineseChars: string
      englishWords: string
    }
    language: {
      title: string
      select: string
    }
  }

  // Selection Chat
  selection?: {
    actions?: {
      addToChat?: string
      rewrite?: string
      explain?: string
    }
  }

  // Chat Interface
  chat: {
    placeholder: string
    sendMessage: string
    newChat: string
    continueResponse?: string
    stopGeneration?: string
    vaultSearch: string
    selectModel: string
    uploadImage: string
    addContext: string
    applyChanges: string
    copyMessage: string
    regenerate: string
    reasoning: string
    annotations: string
    // 系统提示词相关
    systemPrompt?: {
      toggleTitle: string
      toggleAria: string
      title: string
      description: string
      empty: string
      hasChanges: string
      applyChanges: string
      discardChanges: string
      groupStats: string
      searchPlaceholder: string
      noResults: string
      resetToDefault: string
      confirmReset: string
      enableGroup: string
      disableGroup: string
      enablePrompt: string
      disablePrompt: string
      allEnabled: string
      allDisabled: string
      partiallyEnabled: string
      selectAll: string
      deselectAll: string
      expandAll: string
      collapseAll: string
      previewTitle: string
    }
    codeBlock?: {
      showRawText?: string
      showFormattedText?: string
      copyText?: string
      textCopied?: string
      apply?: string
      applying?: string
    }
    customContinuePromptLabel?: string
    customContinuePromptPlaceholder?: string
    customContinueHint?: string
    customContinueConfirmHint?: string
    customRewritePromptPlaceholder?: string
    customContinueProcessing?: string
    customContinueError?: string
    customContinuePresets?: {
      continue?: { label: string; instruction: string }
      summarize?: { label: string; instruction: string }
      flowchart?: { label: string; instruction: string }
    }
    customContinueSections?: {
      suggestions?: {
        title: string
        items?: {
          continue?: { label: string; instruction: string }
        }
      }
      writing?: {
        title: string
        items?: {
          summarize?: { label: string; instruction: string }
          todo?: { label: string; instruction: string }
          flowchart?: { label: string; instruction: string }
          table?: { label: string; instruction: string }
          freewrite?: { label: string; instruction: string }
        }
      }
      thinking?: {
        title: string
        items?: {
          brainstorm?: { label: string; instruction: string }
          analyze?: { label: string; instruction: string }
          dialogue?: { label: string; instruction: string }
        }
      }
      custom?: {
        title: string
      }
    }
    showMore?: string
    showLess?: string
    // conversation settings popover
    conversationSettings?: {
      openAria?: string
      chatMemory?: string
      maxContext?: string
      sampling?: string
      temperature?: string
      topP?: string
      streaming?: string
      vaultSearch?: string
      useVaultSearch?: string
      geminiTools?: string
      webSearch?: string
      urlContext?: string
    }
  }

  // Notices and Messages
  notices: {
    rebuildingIndex: string
    rebuildComplete: string
    rebuildFailed: string
    pgliteUnavailable: string
    downloadingPglite: string
    updatingIndex: string
    indexUpdated: string
    indexUpdateFailed: string
    migrationComplete: string
    migrationFailed: string
    reloadingPlugin: string
    settingsInvalid: string
  }

  // Errors
  errors: {
    providerNotFound: string
    modelNotFound: string
    invalidApiKey: string
    networkError: string
    databaseError: string
    mcpServerError: string
  }

  // Apply View
  applyView?: {
    applying?: string
    changesResolved?: string
    acceptAllIncoming?: string
    rejectAll?: string
    reset?: string
    applyAndClose?: string
    acceptIncoming?: string
    acceptCurrent?: string
    acceptBoth?: string
    acceptedIncoming?: string
    keptCurrent?: string
    mergedBoth?: string
    undo?: string
  }

  // Quick Ask
  quickAsk?: {
    selectAssistant?: string
    noAssistant?: string
    noAssistantDescription?: string
    navigationHint?: string
    inputPlaceholder?: string
    close?: string
    copy?: string
    insert?: string
    openInSidebar?: string
    stop?: string
    send?: string
    clear?: string
    clearConfirm?: string
    cleared?: string
    error?: string
    copied?: string
    inserted?: string
    // Mode select
    modeAsk?: string
    modeEdit?: string
    modeEditDirect?: string
    modeAskDesc?: string
    modeEditDesc?: string
    modeEditDirectDesc?: string
    editNoFile?: string
    editNoChanges?: string
    editPartialSuccess?: string
    editApplied?: string
  }
}
