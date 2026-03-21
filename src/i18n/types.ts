export type Language = 'en' | 'zh' | 'it'

export type TranslationKeys = {
  // Commands
  commands: {
    openChat: string
    openChatSidebar: string
    openChatTab: string
    openChatWindow: string
    openNewChatTab: string
    openNewChatWindow: string
    addSelectionToChat: string
    addFileToChat: string
    addFolderToChat: string
    rebuildVaultIndex: string
    updateVaultIndex: string
    continueWriting: string
    continueWritingSelected: string
    customContinueWriting: string
    customRewrite: string
    triggerSmartSpace: string
    triggerQuickAsk: string
    triggerTabCompletion: string
    acceptInlineSuggestion: string
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
    characters: string
    words: string
    wordsCharacters: string
    // additions
    default?: string
    modelDefault?: string
    on?: string
    off?: string
    noResults?: string
  }

  sidebar?: {
    tabs: {
      chat: string
      agent?: string
      composer: string
    }
    chatList?: {
      searchPlaceholder?: string
      empty?: string
      retryTitle?: string
      archived?: string
      hideArchived?: string
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
    tabs: {
      models: string
      editor: string
      knowledge: string
      tools: string
      agent: string
      others: string
    }
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
      tabCompletionSystemPrompt?: string
      tabCompletionSystemPromptDesc?: string
    }
    chatPreferences: {
      title: string
      includeCurrentFile: string
      includeCurrentFileDesc: string
      historyArchiveEnabled?: string
      historyArchiveEnabledDesc?: string
      historyArchiveThreshold?: string
      historyArchiveThresholdDesc?: string
    }
    assistants: {
      title: string
      desc: string
      configureAssistants: string
      assistantsCount: string
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
    agent?: {
      title?: string
      desc?: string
      globalCapabilities?: string
      mcpServerCount?: string
      tools?: string
      toolsCount?: string
      toolsCountWithEnabled?: string
      skills?: string
      skillsCount?: string
      skillsCountWithEnabled?: string
      skillsGlobalDesc?: string
      yoloBaseDir?: string
      yoloBaseDirDesc?: string
      yoloBaseDirPlaceholder?: string
      skillsSourcePath?: string
      refreshSkills?: string
      skillsEmptyHint?: string
      createSkillTemplates?: string
      skillsTemplateCreated?: string
      agents?: string
      agentsDesc?: string
      configureAgents?: string
      noAgents?: string
      newAgent?: string
      current?: string
      duplicate?: string
      copySuffix?: string
      deleteConfirmTitle?: string
      deleteConfirmMessagePrefix?: string
      deleteConfirmMessageSuffix?: string
      toolSourceBuiltin?: string
      toolSourceMcp?: string
      noMcpTools?: string
      toolsEnabledCount?: string
      manageTools?: string
      manageSkills?: string
      descriptionColumn?: string
      builtinFsListLabel?: string
      builtinFsListDesc?: string
      builtinFsSearchLabel?: string
      builtinFsSearchDesc?: string
      builtinFsReadLabel?: string
      builtinFsReadDesc?: string
      builtinFsEditLabel?: string
      builtinFsEditDesc?: string
      fsEditReviewToggle?: string
      fsEditReviewToggleDesc?: string
      safetyControls?: string
      safetyControlsDesc?: string
      builtinFsFileOpsLabel?: string
      builtinFsFileOpsDesc?: string
      builtinMemoryOpsLabel?: string
      builtinMemoryOpsDesc?: string
      builtinMemoryAddLabel?: string
      builtinMemoryAddDesc?: string
      builtinMemoryUpdateLabel?: string
      builtinMemoryUpdateDesc?: string
      builtinMemoryDeleteLabel?: string
      builtinMemoryDeleteDesc?: string
      builtinOpenSkillLabel?: string
      builtinOpenSkillDesc?: string
      editorDefaultName?: string
      editorIntro?: string
      editorTabProfile?: string
      editorTabTools?: string
      editorTabSkills?: string
      editorTabModel?: string
      editorName?: string
      editorNameDesc?: string
      editorDescription?: string
      editorDescriptionDesc?: string
      editorIcon?: string
      editorIconDesc?: string
      editorChooseIcon?: string
      editorSystemPrompt?: string
      editorSystemPromptDesc?: string
      editorEnableTools?: string
      editorEnableToolsDesc?: string
      editorIncludeBuiltinTools?: string
      editorIncludeBuiltinToolsDesc?: string
      toolApproval?: string
      toolApprovalFullAccess?: string
      toolApprovalRequire?: string
      editorEnabled?: string
      editorDisabled?: string
      editorModel?: string
      editorModelDesc?: string
      editorModelCurrent?: string
      editorModelSampling?: string
      editorModelResetDefaults?: string
      modelPresetFocused?: string
      modelPresetBalanced?: string
      modelPresetCreative?: string
      editorTemperature?: string
      editorTemperatureDesc?: string
      editorTopP?: string
      editorTopPDesc?: string
      editorMaxOutputTokens?: string
      editorMaxOutputTokensDesc?: string
      editorMaxContextMessages?: string
      editorCustomParameters?: string
      editorCustomParametersDesc?: string
      editorCustomParametersAdd?: string
      editorCustomParametersKeyPlaceholder?: string
      editorCustomParametersValuePlaceholder?: string
      editorToolsCount?: string
      editorSkillsCount?: string
      editorSkillsCountWithEnabled?: string
      skillLoadAlways?: string
      skillLoadLazy?: string
      skillDisabledGlobally?: string
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
      useObsidianRequestUrl: string
      useObsidianRequestUrlDesc: string
      requestTransportMode: string
      requestTransportModeDesc: string
      requestTransportModeAuto: string
      requestTransportModeBrowser: string
      requestTransportModeObsidian: string
      customHeaders: string
      customHeadersDesc: string
      customHeadersAdd: string
      customHeadersKeyPlaceholder: string
      customHeadersValuePlaceholder: string
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
      reasoningTypeAnthropic?: string
      reasoningTypeGeneric?: string
      openaiReasoningEffort?: string
      openaiReasoningEffortDesc?: string
      geminiThinkingBudget?: string
      geminiThinkingBudgetDesc?: string
      geminiThinkingBudgetPlaceholder?: string
      toolType?: string
      toolTypeDesc?: string
      toolTypeNone?: string
      toolTypeGemini?: string
      sampling?: string
      restoreDefaults?: string
      maxOutputTokens?: string
      customParameters?: string
      customParametersDesc?: string
      customParametersAdd?: string
      customParametersKeyPlaceholder?: string
      customParametersValuePlaceholder?: string
      customParameterTypeText?: string
      customParameterTypeNumber?: string
      customParameterTypeBoolean?: string
      customParameterTypeJson?: string
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
      advanced?: string
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
      addServerTitle?: string
      editServerTitle?: string
      serverNameField?: string
      serverNameFieldDesc?: string
      serverNamePlaceholder?: string
      parametersField?: string
      parametersFieldDesc?: string
      parametersFieldDescShort?: string
      parametersFormatHelp?: string
      parametersTooltipDesc?: string
      parametersTooltipTitle?: string
      parametersTooltipPreferred?: string
      parametersTooltipCompatible?: string
      parametersTooltipTip?: string
      serverNameRequired?: string
      serverAlreadyExists?: string
      parametersRequired?: string
      parametersMustBeValidJson?: string
      invalidJsonFormat?: string
      invalidParameters?: string
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
      selectionChatSubsectionTitle: string
      selectionChatDescription: string
      selectionChatToggle: string
      selectionChatToggleDesc: string
      selectionChatAutoDock?: string
      selectionChatAutoDockDesc?: string
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
      quickAskContextBeforeChars?: string
      quickAskContextBeforeCharsDesc?: string
      quickAskContextAfterChars?: string
      quickAskContextAfterCharsDesc?: string
      // Tab completion settings
      tabCompletionBasicTitle: string
      tabCompletionBasicDesc: string
      tabCompletionTriggersSectionTitle: string
      tabCompletionTriggersSectionDesc: string
      tabCompletionAutoSectionTitle: string
      tabCompletionAutoSectionDesc: string
      tabCompletionAdvancedSectionDesc: string
      tabCompletion: string
      tabCompletionDesc: string
      tabCompletionModel: string
      tabCompletionModelDesc: string
      tabCompletionTriggerDelay: string
      tabCompletionTriggerDelayDesc: string
      tabCompletionAutoTrigger: string
      tabCompletionAutoTriggerDesc: string
      tabCompletionAutoTriggerDelay: string
      tabCompletionAutoTriggerDelayDesc: string
      tabCompletionAutoTriggerCooldown: string
      tabCompletionAutoTriggerCooldownDesc: string
      tabCompletionMaxSuggestionLength: string
      tabCompletionMaxSuggestionLengthDesc: string
      tabCompletionLengthPreset: string
      tabCompletionLengthPresetDesc: string
      tabCompletionLengthPresetShort: string
      tabCompletionLengthPresetMedium: string
      tabCompletionLengthPresetLong: string
      tabCompletionAdvanced: string
      tabCompletionContextRange: string
      tabCompletionContextRangeDesc: string
      tabCompletionMinContextLength: string
      tabCompletionMinContextLengthDesc: string
      tabCompletionTemperature: string
      tabCompletionTemperatureDesc: string
      tabCompletionRequestTimeout: string
      tabCompletionRequestTimeoutDesc: string
      tabCompletionConstraints: string
      tabCompletionConstraintsDesc: string
      tabCompletionTriggersTitle: string
      tabCompletionTriggersDesc: string
      tabCompletionTriggerAdd: string
      tabCompletionTriggerEnabled: string
      tabCompletionTriggerType: string
      tabCompletionTriggerTypeString: string
      tabCompletionTriggerTypeRegex: string
      tabCompletionTriggerPattern: string
      tabCompletionTriggerDescription: string
      tabCompletionTriggerRemove: string
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
      clearChatSnapshots?: string
      clearChatSnapshotsDesc?: string
      clearChatSnapshotsConfirm?: string
      clearChatSnapshotsSuccess?: string
      resetProviders?: string
      resetProvidersDesc?: string
      resetProvidersConfirm?: string
      resetProvidersSuccess?: string
      resetAgents?: string
      resetAgentsDesc?: string
      resetAgentsConfirm?: string
      resetAgentsSuccess?: string
      yoloBaseDir?: string
      yoloBaseDirDesc?: string
      yoloBaseDirPlaceholder?: string
      mentionDisplayMode?: string
      mentionDisplayModeDesc?: string
      mentionDisplayModeInline?: string
      mentionDisplayModeBadge?: string
      chatApplyMode?: string
      chatApplyModeDesc?: string
      chatApplyModeReviewRequired?: string
      chatApplyModeDirectApply?: string
      persistSelectionHighlight?: string
      persistSelectionHighlightDesc?: string
    }
    smartSpace?: {
      quickActionsTitle: string
      quickActionsDesc: string
      configureActions: string
      actionsCount: string
      addAction: string
      resetToDefault: string
      confirmReset: string
      resetConfirmTitle?: string
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
    selectionChat?: {
      quickActionsTitle: string
      quickActionsDesc: string
      configureActions: string
      actionsCount: string
      addAction: string
      resetToDefault: string
      confirmReset: string
      resetConfirmTitle?: string
      actionLabel: string
      actionLabelDesc: string
      actionLabelPlaceholder: string
      actionMode: string
      actionModeDesc: string
      actionModeAsk: string
      actionModeChatInput: string
      actionModeRewrite: string
      actionRewriteType: string
      actionRewriteTypeDesc: string
      actionRewriteTypeCustom: string
      actionRewriteTypePreset: string
      actionInstruction: string
      actionInstructionDesc: string
      actionInstructionPlaceholder: string
      actionInstructionRewriteDesc: string
      actionInstructionRewritePlaceholder: string
      duplicate: string
      copySuffix?: string
      dragHandleAria?: string
    }
  }

  // Selection Chat
  selection?: {
    actions?: {
      addToChat?: string
      addToSidebar?: string
      customRewrite?: string
      customAsk?: string
      rewrite?: string
      explain?: string
      suggest?: string
      translateToChinese?: string
    }
  }

  // Chat Interface
  chat: {
    placeholder: string
    placeholderCompact?: string
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
    createBranchFromHere?: string
    branchCreated?: string
    branchCreateFailed?: string
    insertAtCursor?: string
    insertSuccess?: string
    insertUnavailable?: string
    noAssistantContent?: string
    regenerate: string
    reasoning: string
    annotations: string
    mentionMenu?: {
      back?: string
      entryCurrentFile?: string
      entryMode?: string
      entrySkill?: string
      entryAssistant?: string
      entryFile?: string
      entryFolder?: string
    }
    emptyState?: {
      chatTitle?: string
      chatDescription?: string
      agentTitle?: string
      agentDescription?: string
    }
    codeBlock?: {
      showRawText?: string
      showFormattedText?: string
      copyText?: string
      textCopied?: string
      apply?: string
      applying?: string
      locatingTarget?: string
      emptyPlanPreview?: string
      stopApplying?: string
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
    toolCall?: {
      status?: {
        call?: string
        rejected?: string
        running?: string
        failed?: string
        aborted?: string
        unknown?: string
      }
      displayName?: {
        fs_list?: string
        fs_search?: string
        fs_read?: string
        fs_edit?: string
        fs_file_ops?: string
        memory_add?: string
        memory_update?: string
        memory_delete?: string
        open_skill?: string
      }
      writeAction?: {
        create_file?: string
        delete_file?: string
        create_dir?: string
        delete_dir?: string
        move?: string
      }
      detail?: {
        target?: string
        scope?: string
        query?: string
        path?: string
        paths?: string
      }
      parameters?: string
      noParameters?: string
      result?: string
      error?: string
      allow?: string
      reject?: string
      abort?: string
      alwaysAllowThisTool?: string
      allowForThisChat?: string
    }
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
    transportModeAutoPromoted: string
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
    prevChange?: string
    nextChange?: string
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
    statusRequesting?: string
    statusThinking?: string
    statusGenerating?: string
    statusModifying?: string
  }

  // Chat Mode Select
  chatMode?: {
    chat?: string
    chatDesc?: string
    rewrite?: string
    rewriteDesc?: string
    agent?: string
    agentDesc?: string
    warning?: {
      title?: string
      description?: string
      permission?: string
      cost?: string
      backup?: string
      checkbox?: string
      cancel?: string
      confirm?: string
    }
  }

  // Reasoning Select
  reasoning?: {
    selectReasoning?: string
    off?: string
    on?: string
    auto?: string
    low?: string
    medium?: string
    high?: string
    extraHigh?: string
  }
}
