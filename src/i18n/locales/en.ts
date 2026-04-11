import type { TranslationKeys } from '../types'

export const en: TranslationKeys = {
  commands: {
    openChat: 'Open chat',
    openChatSidebar: 'Open chat (sidebar)',
    newChatCurrentView: 'New chat',
    openYoloNewChat: 'YOLO: Open chat window',
    openNewChatTab: 'Open new chat (new tab)',
    openNewChatSplit: 'Open new chat (right split)',
    openNewChatWindow: 'Open new chat (new window)',
    addSelectionToChat: 'Add selection to chat',
    addFileToChat: 'Add file to chat',
    addFolderToChat: 'Add folder to chat',
    rebuildVaultIndex: 'Rebuild entire vault index',
    updateVaultIndex: 'Update index for modified files',
    continueWriting: 'AI continue writing',
    continueWritingSelected: 'AI continue writing (selection)',
    customContinueWriting: 'AI custom continue',
    customRewrite: 'AI custom rewrite',
    triggerSmartSpace: 'Trigger smart space',
    triggerQuickAsk: 'Trigger quick ask',
    triggerTabCompletion: 'Trigger tab completion',
    acceptInlineSuggestion: 'Accept completion',
  },

  common: {
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    add: 'Add',
    adding: 'Adding...',
    probingDimension: 'Detecting dimensions...',
    clear: 'Clear',
    remove: 'Remove',
    confirm: 'Confirm',
    close: 'Close',
    loading: 'Loading...',
    error: 'Error',
    success: 'Success',
    warning: 'Warning',
    retry: 'Retry',
    copy: 'Copy',
    paste: 'Paste',
    characters: 'Chars',
    words: 'Words',
    wordsCharacters: 'Words/characters',
    default: 'Default',
    modelDefault: 'Model default',
    on: 'On',
    off: 'Off',
    noResults: 'No matches found',
  },

  sidebar: {
    tabs: {
      chat: 'Chat',
      agent: 'Agent',
      composer: 'Sparkle',
    },
    chatList: {
      searchPlaceholder: 'Search conversations',
      empty: 'No conversations',
      retryTitle: 'Retry title',
      archived: 'Archived',
      hideArchived: 'Hide archived',
      exportConversation: 'Export conversation to vault',
      moreActions: 'More actions',
    },
    chat: {
      exportSuccess: 'Exported chat to {path}',
      exportError: 'Could not export conversation',
    },
    composer: {
      title: 'Sparkle',
      subtitle:
        'Configure continuation parameters and context before generating.',
      backToChat: 'Back to chat',
      modelSectionTitle: 'Model',
      continuationModel: 'Continuation model',
      continuationModelDesc:
        'When super continuation is enabled, this view uses this model for continuation tasks.',
      contextSectionTitle: 'Context sources',
      ragToggle: 'Enable retrieval with embeddings',
      ragToggleDesc:
        'Fetch similar notes via embeddings before generating new text.',
      sections: {
        modelWithPrompt: {
          title: 'Model & prompt',
        },
        model: {
          title: 'Model selection',
          desc: 'Choose which model powers these tasks.',
        },
        parameters: {
          title: 'Parameters',
          desc: 'Adjust parameters for the model used in this view.',
        },
        context: {
          title: 'Context management',
          desc: 'Prioritize the content sources referenced when this view runs.',
        },
      },
      continuationPrompt: 'Continuation system prompt',
      maxContinuationChars: 'Max continuation characters',
      referenceRulesTitle: 'Reference rules',
      referenceRulesPlaceholder:
        'Select folders whose content should be fully injected.',
      knowledgeBaseTitle: 'Knowledge base',
      knowledgeBasePlaceholder:
        'Select folders or files used as the retrieval scope (leave empty for all).',
      knowledgeBaseHint:
        'Enable embedding search to limit the retrieval scope.',
    },
  },

  smartSpace: {
    webSearch: 'Web',
    urlContext: 'URL',
    mentionContextLabel: 'Mentioned files',
  },

  selection: {
    actions: {
      addToChat: 'Add to chat',
      addToSidebar: 'Add to sidebar',
      customRewrite: 'Custom rewrite',
      customAsk: 'Custom ask',
      rewrite: 'AI rewrite',
      explain: 'Explain in depth',
      suggest: 'Provide suggestions',
      translateToChinese: 'Translate to Chinese',
    },
  },

  settings: {
    title: 'Yolo settings',
    tabs: {
      models: 'Models',
      editor: 'Editor',
      knowledge: 'Knowledge',
      tools: 'Tools',
      agent: 'Agent',
      others: 'Others',
    },
    supportSmartComposer: {
      name: 'Support the project',
      desc: 'If you find this plugin valuable, consider supporting its development!',
      buyMeACoffee: 'Buy me a coffee',
    },
    defaults: {
      title: 'Default model policies & prompts',
      defaultChatModel: 'Default chat model',
      defaultChatModelDesc:
        'Choose the model you want to use for sidebar chat.',
      chatTitleModel: 'Conversation title and summary model',
      chatTitleModelDesc:
        'Choose the model used for automatic conversation naming and compact summaries.',
      streamFallbackRecovery: 'Enable automatic recovery',
      streamFallbackRecoveryDesc:
        'When the streaming primary request times out or fails, retry once with a non-streaming fallback.',
      primaryRequestTimeout: 'Primary request timeout (seconds)',
      primaryRequestTimeoutDesc:
        'How long to wait before the streaming primary request is treated as timed out. This timeout always applies; if automatic recovery is enabled, a non-streaming fallback is attempted afterward. Default: 60 seconds.',
      globalSystemPrompt: 'Global system prompt',
      globalSystemPromptDesc:
        'This prompt is added to the beginning of every chat conversation. Supported variables: date {{current_date}}, date + current hour {{current_hour}}, date + current hour and minute {{current_minute}}, weekday {{current_weekday}}.',
      continuationSystemPrompt: 'Default continuation system prompt',
      continuationSystemPromptDesc:
        'Used as the system message when generating continuation text; leave empty to fall back to the built-in default.',
      chatTitlePrompt: 'Chat title prompt',
      chatTitlePromptDesc:
        'Prompt used when automatically generating conversation titles from the first user message.',
      tabCompletionSystemPrompt: 'Tab completion system prompt',
      tabCompletionSystemPromptDesc:
        'System message applied when generating tab completion suggestions; leave empty to use the built-in default.',
    },
    smartSpace: {
      quickActionsTitle: 'Smart space quick actions',
      quickActionsDesc:
        'Customize the quick actions and prompts displayed in smart space',
      configureActions: 'Configure quick actions',
      actionsCount: 'Configured {count} quick actions',
      addAction: 'Add action',
      resetToDefault: 'Reset to default',
      confirmReset:
        'Are you sure you want to reset to default quick actions and delete all custom settings?',
      resetConfirmTitle: 'Reset Smart Space quick actions',
      actionLabel: 'Action label',
      actionLabelDesc: 'Text displayed in the quick action',
      actionLabelPlaceholder: 'For example, continue writing',
      actionInstruction: 'Prompt',
      actionInstructionDesc: 'Instruction sent to AI',
      actionInstructionPlaceholder:
        'For example, please continue expanding the current paragraph while maintaining the original tone and style.',
      actionCategory: 'Category',
      actionCategoryDesc: 'Category this action belongs to',
      actionIcon: 'Icon',
      actionIconDesc: 'Choose an icon',
      actionEnabled: 'Enabled',
      actionEnabledDesc: 'Whether to show this action in smart space',
      moveUp: 'Move up',
      moveDown: 'Move down',
      duplicate: 'Duplicate',
      disabled: 'Disabled',
      categories: {
        suggestions: 'Suggestions',
        writing: 'Writing',
        thinking: 'Thinking · inquiry · dialogue',
        custom: 'Custom',
      },
      iconLabels: {
        sparkles: 'Sparkles',
        file: 'File',
        todo: 'Todo',
        workflow: 'Workflow',
        table: 'Table',
        pen: 'Pen',
        lightbulb: 'Lightbulb',
        brain: 'Brain',
        message: 'Message',
        settings: 'Settings',
      },
      copySuffix: ' (copy)',
      dragHandleAria: 'Drag to reorder',
    },
    selectionChat: {
      quickActionsTitle: 'Cursor Chat quick actions',
      quickActionsDesc:
        'Customize the quick actions and prompts displayed after selecting text',
      configureActions: 'Configure quick actions',
      actionsCount: 'Configured {count} quick actions',
      addAction: 'Add quick action',
      resetToDefault: 'Reset to default',
      confirmReset:
        'Are you sure you want to reset to default quick actions and delete all custom settings?',
      resetConfirmTitle: 'Reset Cursor Chat quick actions',
      actionLabel: 'Action label',
      actionLabelDesc: 'Text displayed in the quick action',
      actionLabelPlaceholder: 'For example, explain',
      actionMode: 'Mode',
      actionModeDesc:
        'The first two use Quick Ask: Ask auto-sends, and Rewrite enters preview mode. The last two use Chat: you can either prefill the input box or send immediately.',
      actionModeAsk: 'Quick Ask ask',
      actionModeChatInput: 'Add to chat input',
      actionModeChatSend: 'Add to chat input and send',
      actionModeRewrite: 'Quick Ask rewrite',
      actionRewriteType: 'Rewrite type',
      actionRewriteTypeDesc: 'Choose whether rewrite requires a prompt',
      actionRewriteTypeCustom: 'Custom prompt (ask each time)',
      actionRewriteTypePreset: 'Preset prompt (run directly)',
      actionInstruction: 'Prompt',
      actionInstructionDesc: 'Instruction sent to AI',
      actionInstructionPlaceholder:
        'For example, explain the selected content.',
      actionInstructionRewriteDesc:
        'Rewrite instruction (required for preset prompt).',
      actionInstructionRewritePlaceholder:
        'For example: make it concise and keep Markdown structure.',
      duplicate: 'Duplicate',
      copySuffix: ' (copy)',
      dragHandleAria: 'Drag to reorder',
    },
    chatPreferences: {
      title: 'Chat preferences',
      includeCurrentFile: 'Auto-include current page',
      includeCurrentFileDesc:
        'Automatically include the content of your current file in chats.',
      historyArchiveEnabled: 'Enable history archive grouping',
      historyArchiveEnabledDesc:
        'Keep older non-pinned conversations collapsed under an archive section.',
      historyArchiveThreshold: 'Recent conversation limit',
      historyArchiveThresholdDesc:
        'Number of latest non-pinned conversations shown before archiving the rest (20-500).',
    },
    assistants: {
      title: 'Assistants',
      desc: 'Create and manage custom AI assistants',
      configureAssistants: 'Configure assistants',
      assistantsCount: 'Configured {count} assistants',
      addAssistant: 'Add assistant',
      editAssistant: 'Edit assistant',
      deleteAssistant: 'Delete assistant',
      name: 'Name',
      description: 'Description',
      systemPrompt: 'System prompt',
      systemPromptDesc:
        'This prompt will be added to the beginning of every chat. Supports {{current_date}}, {{current_hour}}, {{current_minute}}, and {{current_weekday}}.',
      systemPromptPlaceholder:
        "Enter system prompt to define assistant's behavior and capabilities",
      namePlaceholder: 'Enter assistant name',
      defaultAssistantName: 'New assistant',
      deleteConfirmTitle: 'Confirm delete assistant',
      deleteConfirmMessagePrefix: 'Are you sure you want to delete assistant',
      deleteConfirmMessageSuffix: ' This action cannot be undone.',
      addAssistantAria: 'Add new assistant',
      deleteAssistantAria: 'Delete assistant',
      actions: 'Actions',
      maxContextMessagesDesc:
        'If set, this assistant will use this number of previous chat messages, overriding the global default.',
      noAssistants: 'No assistants available',
      noAssistant: 'Default',
      selectAssistant: 'Select assistant',
    },
    agent: {
      title: 'Agent',
      desc: 'Manage global capabilities and configure your agents.',
      globalCapabilities: 'Global capabilities',
      mcpServerCount: '{count} custom tool servers (MCP) connected',
      tools: 'Tools',
      toolsCount: '{count} tools',
      toolsCountWithEnabled: '{count} tools (enabled {enabled})',
      skills: 'Skills',
      skillsCount: '{count} skills',
      skillsCountWithEnabled: '{count} skills (enabled {enabled})',
      skillsGlobalDesc:
        'Skills are discovered from built-in skills and {path}/**/*.md (excluding Skills.md where applicable). Disable a skill here to block it for all agents.',
      yoloBaseDir: 'YOLO base folder',
      yoloBaseDirDesc:
        'Enter a vault-relative path (without a leading /). Example: use YOLO at vault root, or setting/YOLO under the setting folder.',
      yoloBaseDirPlaceholder: 'YOLO',
      skillsSourcePath:
        'Source: built-in skills + {path}/*.md + {path}/**/SKILL.md',
      refreshSkills: 'Refresh',
      skillsEmptyHint:
        'No skills found. Create skill markdown files under {path}.',
      createSkillTemplates: 'Initialize Skills system',
      skillsTemplateCreated: 'Skills system initialized in {path}.',
      agents: 'Agents',
      agentsDesc: 'Click Configure to edit each agent profile and prompt.',
      configureAgents: 'Configure',
      noAgents: 'No agents configured yet',
      newAgent: 'New agent',
      current: 'Current',
      duplicate: 'Duplicate',
      copySuffix: ' (copy)',
      deleteConfirmTitle: 'Confirm delete agent',
      deleteConfirmMessagePrefix: 'Are you sure you want to delete agent',
      deleteConfirmMessageSuffix: '? This action cannot be undone.',
      toolSourceBuiltin: 'Built-in',
      toolSourceMcp: 'MCP',
      noMcpTools: 'No custom tools (MCP) discovered yet',
      toolsEnabledCount: '{count} enabled',
      manageTools: 'Manage tools',
      manageSkills: 'Manage skills',
      descriptionColumn: 'Description',
      builtinFsListLabel: 'Read Vault',
      builtinFsListDesc:
        'List directory structure under a vault path. Useful for workspace orientation.',
      builtinFsSearchLabel: 'Search Vault',
      builtinFsSearchDesc:
        'Search files, folders, or markdown content in vault.',
      builtinFsReadLabel: 'Read',
      builtinFsReadDesc:
        'Read vault files by path with either full-file or targeted line-range operations.',
      builtinContextPruneToolResultsLabel: 'Prune Tool Results',
      builtinContextPruneToolResultsDesc:
        'Exclude selected historical tool results, or prune all prunable tool results at once, from future model-visible context without deleting chat history.',
      builtinContextCompactLabel: 'Compact Context',
      builtinContextCompactDesc:
        'Compress earlier conversation history into a summary and continue in a fresh context window.',
      builtinFsEditLabel: 'Text Editing',
      builtinFsEditDesc:
        'Apply exactly one text edit operation within a single existing file, including replace, replace_lines, insert_after, and append.',
      safetyControls: 'Safety Controls',
      safetyControlsDesc:
        'Configure extra review behavior before agents perform risky file operations.',
      fsEditReviewToggle: 'Require approval before editing files',
      fsEditReviewToggleDesc:
        'When enabled, agent fs_edit changes open inline/apply review before writing the file.',
      builtinFsFileOpsLabel: 'File Operation Toolset',
      builtinFsFileOpsDesc:
        'Grouped file path operations: create/delete file, create/delete folder, and move.',
      builtinMemoryOpsLabel: 'Memory Toolset',
      builtinMemoryOpsDesc:
        'Grouped memory operations: add, update, and delete memory.',
      builtinMemoryAddLabel: 'Add Memory',
      builtinMemoryAddDesc:
        'Add one memory item into global or assistant memory and auto-assign an id.',
      builtinMemoryUpdateLabel: 'Update Memory',
      builtinMemoryUpdateDesc: 'Update an existing memory item by id.',
      builtinMemoryDeleteLabel: 'Delete Memory',
      builtinMemoryDeleteDesc: 'Delete an existing memory item by id.',
      builtinOpenSkillLabel: 'Open Skill',
      builtinOpenSkillDesc: 'Load a skill markdown file by id or name.',
      editorDefaultName: 'New agent',
      editorIntro: "Configure this agent's capabilities, model, and behavior.",
      editorTabProfile: 'Profile',
      editorTabTools: 'Tools',
      editorTabSkills: 'Skills',
      editorTabModel: 'Model',
      editorName: 'Name',
      editorNameDesc: 'Agent display name',
      editorDescription: 'Description',
      editorDescriptionDesc: 'Short summary for this agent',
      editorIcon: 'Icon',
      editorIconDesc: 'Pick an icon for this agent',
      editorChooseIcon: 'Choose icon',
      editorSystemPrompt: 'System prompt',
      editorSystemPromptDesc:
        'Primary behavior instruction for this agent. Supported variables: date {{current_date}}, date + current hour {{current_hour}}, date + current hour and minute {{current_minute}}, weekday {{current_weekday}}.',
      editorEnableTools: 'Enable tools',
      editorEnableToolsDesc: 'Allow this agent to call tools',
      editorIncludeBuiltinTools: 'Include built-in tools',
      editorIncludeBuiltinToolsDesc:
        'Allow local vault file tools for this agent',
      toolApproval: 'Approval',
      toolApprovalFullAccess: 'Full access',
      toolApprovalRequire: 'Require approval',
      editorEnabled: 'Enabled',
      editorDisabled: 'Disabled',
      editorModel: 'Model',
      editorModelDesc: 'Select the model used by this agent',
      editorModelCurrent: 'Current: {model}',
      editorModelSampling: 'Sampling parameters',
      editorModelResetDefaults: 'Restore defaults',
      modelPresetFocused: 'Focused',
      modelPresetBalanced: 'Balanced',
      modelPresetCreative: 'Creative',
      editorTemperature: 'Temperature',
      editorTemperatureDesc: '0.0 - 2.0',
      editorTopP: 'Top P',
      editorTopPDesc: '0.0 - 1.0',
      editorMaxOutputTokens: 'Max output tokens',
      editorMaxOutputTokensDesc: 'Maximum generated tokens',
      editorMaxContextMessages: 'Max context messages',
      editorCustomParameters: 'Custom parameters',
      editorCustomParametersDesc:
        'Additional request fields for this agent. Same keys override model-level parameters',
      editorCustomParametersAdd: 'Add parameter',
      editorCustomParametersKeyPlaceholder: 'Key',
      editorCustomParametersValuePlaceholder: 'Value',
      editorToolsCount: '{count} tools',
      editorEstimatedContextTokens: '~{count} tokens',
      editorSkillsCount: '{count} skills',
      editorSkillsCountWithEnabled: '{count} skills (enabled {enabled})',
      skillLoadAlways: 'Full inject',
      skillLoadLazy: 'On demand',
      skillDisabledGlobally: 'Disabled globally',
      autoContextCompactionBlockTitle: 'Context compaction',
      autoContextCompaction: 'Automatic context compaction',
      autoContextCompactionDesc:
        'When the last assistant reply’s prompt token usage crosses the threshold, compact older history before your next message is sent (not during the reply).',
      autoContextCompactionThresholdMode: 'Compaction threshold mode',
      autoContextCompactionModeTokens: 'Absolute prompt tokens',
      autoContextCompactionModeRatio: 'Fraction of context window',
      autoContextCompactionThresholdTokens: 'Prompt token threshold',
      autoContextCompactionThresholdTokensDesc:
        'Trigger when the last reply’s reported prompt_tokens is at least this value.',
      autoContextCompactionThresholdRatioPercent: 'Context window usage (%)',
      autoContextCompactionThresholdRatioPercentDesc:
        'Trigger when prompt_tokens divided by the chat model’s max context window reaches this percentage. Requires max context tokens on the model.',
    },
    providers: {
      title: 'Providers',
      desc: 'Enter your API keys for the providers you want to use',
      howToGetApiKeys: 'How to obtain API keys',
      addProvider: 'Add provider',
      providersCount: '{count} providers added',
      editProvider: 'Edit provider',
      deleteProvider: 'Delete provider',
      deleteConfirm: 'Are you sure you want to delete provider',
      deleteWarning: 'This will also delete',
      requestDelete: 'Delete provider',
      deleteConfirmTitle: 'Delete provider "{provider}"?',
      deleteConfirmImpact:
        'This also removes {chatCount} chat models, {embeddingCount} embedding models, and related vector data.',
      confirmDeleteAction: 'Confirm delete',
      chatModels: 'chats',
      embeddingModels: 'embeddings',
      embeddingsWillBeDeleted:
        'All embeddings generated using the related embedding models will also be deleted.',
      editProviderTitle: 'Edit provider',
      providerId: 'ID',
      providerIdDesc:
        'Choose an ID to identify this provider in your settings. This is just for your reference.',
      providerIdPlaceholder: 'Example: my-custom-provider',
      apiKey: 'API key',
      apiKeyDesc: 'Leave empty if not required.',
      apiKeyPlaceholder: 'Enter your API key',
      baseUrl: 'Base URL',
      baseUrlDesc:
        'API endpoint for third-party services, e.g.: https://api.example.com/v1 or https://your-proxy.com/openai (Leave empty to use default)',
      baseUrlPlaceholder: 'https://api.example.com/v1',
      noStainlessHeaders: 'No stainless headers',
      noStainlessHeadersDesc:
        'Enable this if you encounter cross-origin errors related to stainless headers.',
      useObsidianRequestUrl: 'Use Obsidian requestUrl',
      useObsidianRequestUrlDesc:
        'Use Obsidian requestUrl to bypass cross-origin restrictions. Streaming responses are buffered.',
      requestTransportMode: 'Request transport mode',
      requestTransportModeDesc:
        'Auto tries browser fetch first, then desktop Node fetch, and finally falls back to Obsidian requestUrl on CORS/network errors. Obsidian mode buffers streaming responses, while Node mode uses desktop Node fetch for real streaming.',
      requestTransportModeAuto: 'Auto (recommended)',
      requestTransportModeBrowser: 'Browser fetch only',
      requestTransportModeObsidian: 'Obsidian requestUrl only',
      requestTransportModeNode: 'Desktop Node fetch only',
      customHeaders: 'Custom headers',
      customHeadersDesc:
        'Attach extra HTTP headers to all requests sent through this provider.',
      customHeadersAdd: 'Add header',
      customHeadersKeyPlaceholder: 'Header name',
      customHeadersValuePlaceholder: 'Header value',
      chatgptOAuthTitle: 'ChatGPT OAuth',
      chatgptOAuthConnect: 'Connect',
      chatgptOAuthDisconnect: 'Disconnect',
      chatgptOAuthConnecting: 'Connecting...',
      chatgptOAuthLoadingStatus: 'Loading ChatGPT OAuth status...',
      chatgptOAuthConnected: 'Connected',
      chatgptOAuthExpires: 'expires',
      chatgptOAuthDisconnectedHelp:
        'Not connected. Connect to use models from your ChatGPT Plus / Pro account.',
      chatgptOAuthStreamingNotice:
        'ChatGPT OAuth supports streaming. Obsidian requestUrl buffers the response, while desktop Node fetch can stream it in real time.',
      chatgptOAuthPendingCode: 'Current device code:',
      geminiOAuthTitle: 'Gemini OAuth',
      geminiOAuthConnect: 'Connect',
      geminiOAuthDisconnect: 'Disconnect',
      geminiOAuthConnecting: 'Connecting...',
      geminiOAuthLoadingStatus: 'Loading Gemini OAuth status...',
      geminiOAuthConnected: 'Connected',
      geminiOAuthExpires: 'expires',
      geminiOAuthDisconnectedHelp:
        'Not connected. Connect to use Gemini quota from your Google account.',
      geminiOAuthProject: 'project',
      geminiOAuthStreamingNotice:
        'Gemini OAuth supports streaming. Obsidian requestUrl buffers the response, while desktop Node fetch can stream it in real time.',
      qwenOAuthTitle: 'Qwen OAuth',
      qwenOAuthConnect: 'Connect',
      qwenOAuthDisconnect: 'Disconnect',
      qwenOAuthConnecting: 'Connecting...',
      qwenOAuthLoadingStatus: 'Loading Qwen OAuth status...',
      qwenOAuthConnected: 'Connected',
      qwenOAuthExpires: 'expires',
      qwenOAuthDisconnectedHelp:
        'Not connected. Connect to use models from your Qwen account.',
      qwenOAuthStreamingNotice:
        'Qwen OAuth supports streaming. Obsidian requestUrl buffers the response, while desktop Node fetch can stream it in real time.',
    },
    models: {
      title: 'Models',
      chatModels: 'Chat models',
      embeddingModels: 'Embedding models',
      addChatModel: 'Add chat model',
      addEmbeddingModel: 'Add embedding model',
      addCustomChatModel: 'Add custom chat model',
      addCustomEmbeddingModel: 'Add custom embedding model',
      editChatModel: 'Edit chat model',
      editEmbeddingModel: 'Edit embedding model',
      editCustomChatModel: 'Edit custom chat model',
      editCustomEmbeddingModel: 'Edit custom embedding model',
      modelId: 'Model ID',
      modelIdDesc:
        'API model identifier used for requests (e.g., gpt-4o-mini, claude-3-5-sonnet)',
      modelIdPlaceholder: 'Example: gpt-4o-mini',
      modelName: 'Display name',
      modelNamePlaceholder: 'Enter a display name',
      availableModelsAuto: 'Available models (auto-fetched)',
      searchModels: 'Search models...',
      fetchModelsFailed: 'Failed to fetch models',
      embeddingModelsFirst: 'Embedding models are listed first',
      reasoningType: 'Model type',
      reasoningTypeNone: 'Non-reasoning model / default',
      reasoningTypeOpenAI: 'OpenAI reasoning (o3 / o4-mini / gpt-5)',
      reasoningTypeGemini: 'Gemini reasoning (3 pro / flash / flash-lite)',
      reasoningTypeAnthropic: 'Claude extended thinking',
      reasoningTypeGeneric: 'Generic reasoning model',
      openaiReasoningEffort: 'Reasoning effort',
      openaiReasoningEffortDesc:
        'Choose effort: minimal (gpt-5 only) / low / medium / high',
      geminiThinkingBudget: 'Thinking budget (thinking budget)',
      geminiThinkingBudgetDesc:
        'Units are thinking tokens. 0 = off; -1 = dynamic (gemini only); ranges vary by model.',
      geminiThinkingBudgetPlaceholder: 'For example, -1 (dynamic, 0=off)',
      toolType: 'Tool type',
      toolTypeDesc: 'Select the tool type supported by the model',
      toolTypeNone: 'No tools',
      toolTypeGemini: 'Gemini tools',
      toolTypeGpt: 'GPT tools',
      gptTools: 'GPT tools',
      gptToolsDesc: 'Choose the built-in GPT tools available to this model',
      gptToolWebSearch: 'Web Search',
      gptToolWebSearchDesc:
        'Allow the model to search the web and return cited sources.',
      sampling: 'Custom parameters',
      restoreDefaults: 'Restore defaults',
      maxContextTokens: 'Context window tokens',
      maxContextTokensDesc:
        'Auto-filled when this model is recognized. Adjust it if your provider uses a different limit.',
      maxOutputTokens: 'Max output tokens',
      customParameters: 'Custom parameters',
      customParametersDesc:
        'Attach additional request fields; values accept plain text or JSON (for example, {"thinking": {"type": "enabled"}}).',
      customParametersAdd: 'Add parameter',
      customParametersKeyPlaceholder: 'Key',
      customParametersValuePlaceholder: 'Value',
      customParameterTypeText: 'Text',
      customParameterTypeNumber: 'Number',
      customParameterTypeBoolean: 'Boolean',
      customParameterTypeJson: 'JSON',
      dimension: 'Dimension',
      dimensionDesc: 'The dimension of the embedding model (optional)',
      dimensionPlaceholder: '1536',
      noChatModelsConfigured: 'No chat models configured',
      noEmbeddingModelsConfigured: 'No embedding models configured',
    },
    rag: {
      title: 'Knowledge base',
      enableRag: 'Enable knowledge base indexing',
      enableRagDesc:
        'Build indexes for the selected scope and keep them updated automatically in the background.',
      embeddingModel: 'Embedding model',
      embeddingModelDesc: 'Choose the model you want to use for embeddings',
      chunkSize: 'Chunk size',
      chunkSizeDesc:
        "Set the chunk size for text splitting. After changing this, please re-index the vault using the 'rebuild entire vault index' command.",
      minSimilarity: 'Minimum similarity',
      minSimilarityDesc:
        'Minimum similarity score for retrieval-augmented generation results; higher values return more relevant but potentially fewer results.',
      limit: 'Limit',
      limitDesc:
        'Maximum number of retrieval-augmented generation results to include in the prompt; higher values provide more context but increase token usage.',
      includePatterns: 'Include patterns',
      includePatternsDesc:
        "Specify glob patterns to include files in indexing (one per line); for example, use 'notes/**' for all files in the notes folder, leave empty to include all files, and rebuild the entire vault index after changes.",
      excludePatterns: 'Exclude patterns',
      excludePatternsDesc:
        "Specify glob patterns to exclude files from indexing (one per line); for example, use 'notes/**' for all files in the notes folder, leave empty to exclude nothing, and rebuild the entire vault index after changes.",
      testPatterns: 'Test patterns',
      manageEmbeddingDatabase: 'Manage embedding database',
      manage: 'Manage',
      rebuildIndex: 'Rebuild index',
      // UI additions
      selectedFolders: 'Selected folders',
      excludedFolders: 'Excluded folders',
      selectFoldersPlaceholder:
        'Click here to select folders (leave empty to include all)',
      selectFilesOrFoldersPlaceholder:
        'Click here to pick files or folders (leave empty for the entire vault)',
      selectExcludeFoldersPlaceholder:
        'Click here to select folders to exclude (leave empty to exclude nothing)',
      conflictNoteDefaultInclude:
        'Tip: no include folders are selected, so all are included by default; if exclude folders are set, exclusion takes precedence.',
      conflictExact:
        'The following folders are both included and excluded; they will be excluded:',
      conflictParentExclude:
        'The following included folders are under excluded parents and will be excluded:',
      conflictChildExclude:
        'The following excluded subfolders are under included folders (partial exclusion applies):',
      conflictRule:
        'When include and exclude overlap, exclusion takes precedence.',
      // Auto update
      autoUpdate: 'Auto update index',
      autoUpdateDesc:
        'When files within the included folders change, perform incremental updates automatically based on the minimum interval; default once per day.',
      autoUpdateInterval: 'Minimum interval (hours)',
      autoUpdateIntervalDesc:
        'Only trigger auto update after this interval to avoid frequent re-indexing.',
      manualUpdateNow: 'Update now',
      manualUpdateNowDesc:
        'Run an incremental update immediately and record the last updated time.',
      advanced: 'Advanced settings',
      basicCardTitle: 'Knowledge base',
      basicCardDesc:
        'Control knowledge base indexing, the embedding model, and related maintenance actions.',
      resourceCardTitle: 'PGlite Resources',
      resourceCardDesc:
        'Manage the database runtime resources required by the knowledge base.',
      scopeCardTitle: 'Index scope',
      scopeCardDesc:
        'Choose which folders should be included in or excluded from indexing.',
      maintenanceCardTitle: 'Status & maintenance',
      maintenanceCardDesc:
        'Review the current knowledge base status and run maintenance actions when needed.',
      maintenanceUnavailableHint:
        'Prepare PGlite resources above before running index maintenance or embedding database management.',
      currentStatus: 'Current status',
      currentStatusDesc:
        'Once enabled, the knowledge base keeps its index updated automatically in the background.',
      lastIndexedAt: 'Last synced',
      lastIndexedAtDesc:
        'The most recent time indexing or a background sync completed successfully.',
      maintenanceActions: 'Maintenance actions',
      deleteIndex: 'Delete current index',
      deleteIndexConfirm:
        'Delete all index data for the currently selected embedding model?',
      deleteIndexSuccess: 'The current index has been deleted.',
      deleteIndexFailed: 'Failed to delete the current index.',
      statusDisabled: 'Disabled',
      statusSyncing: 'Background sync in progress',
      statusRuntimeRequired: 'Waiting for database resources',
      statusReady: 'Enabled',
      statusEmpty: 'No index has been built yet',
      selectEmbeddingModelFirst:
        'Select an embedding model before enabling knowledge base indexing.',
      openKnowledgeSettings: 'Open knowledge base settings',
      openKnowledgeSettingsDesc:
        'Go to settings to manage indexing, scope, status, and advanced options.',
      composerEntryDesc:
        'Knowledge base indexing is now managed from the settings page, and this view keeps a quick shortcut.',
      pgliteStatusCurrent: 'Current status',
      pgliteStatusSource: 'Resource source',
      pgliteStatusPath: 'Resource path',
      pgliteStatusCheckedAt: 'Last checked',
      pgliteStatusVersion: 'Runtime version',
      pgliteStatusReadyAt: 'Last prepared',
      pgliteStatusReason: 'Details',
      pgliteStateUnchecked: 'Not recorded',
      pgliteStateChecking: 'Checking',
      pgliteStateMissing: 'Not downloaded',
      pgliteStateDownloading: 'Downloading',
      pgliteStateUnavailable: 'Unavailable',
      pgliteStateFailed: 'Failed',
      pgliteStateReady: 'Ready',
      pgliteSourceRemote: 'Remote cache',
      pgliteSourceBundled: 'Bundled with plugin',
      pgliteSourceLocalCache: 'Local cache',
      pgliteDeliveryManual: 'Manual download',
      pgliteDownload: 'Download resources',
      pgliteRedownload: 'Download again',
      pgliteRecheck: 'Check again',
      pgliteDeleteLocal: 'Delete local resources',
      pgliteDownloadPlaceholder:
        'The manual download entry point for remote PGlite resources will be wired here.',
      pgliteDeletePlaceholder:
        'The local PGlite resource deletion entry point will be wired here.',
      pgliteDownloadingUnknownFile: 'runtime file',
      pgliteInlineErrorTitle: 'Download failed',
      pgliteSummaryReadyRemote:
        'PGlite runtime resources are ready and can be used for indexing and embedding database management.',
      pgliteSummaryReadyBundled:
        'The plugin is still using bundled PGlite resources. After remote distribution is introduced, this card will show local cache status and host the manual download entry.',
      pgliteSummaryUnavailable:
        'PGlite runtime resources are unavailable. Index maintenance and embedding database management will remain disabled until resources are ready.',
      pgliteSummaryReady:
        'PGlite runtime resources are ready and can be used for indexing and embedding database management.',
      pgliteSummaryDownloading:
        'PGlite runtime resources are being prepared. Once the download completes, index maintenance and embedding database management will become available automatically.',
      pgliteSummaryFailed:
        'PGlite runtime preparation failed. Retry downloading or clear the local cache before using knowledge base features again.',
      pgliteSummaryMissing:
        'PGlite runtime resources have not been prepared yet. They will be downloaded automatically on first knowledge base use, and you can also prepare them here manually.',
      pgliteDownloadingFile: 'Downloading',
      // Index progress header/status
      indexProgressTitle: 'Retrieval-augmented generation index progress',
      indexing: 'In progress',
      notStarted: 'Not started',
      waitingRateLimit: 'Waiting for rate limit to reset...',
      preparingProgress: 'Preparing index...',
      notIndexedYet: 'Not indexed yet',
      indexComplete: 'Index complete',
      indexIncomplete: 'Last index did not finish',
    },
    mcp: {
      title: 'Custom tools (MCP)',
      desc: 'Configure MCP servers to manage custom tool capabilities',
      warning:
        'When using tools, the tool response is passed to the language model; if the tool result contains a large amount of content, this can significantly increase model usage and associated costs, so please be mindful when enabling or using tools that may return long outputs.',
      notSupportedOnMobile:
        'Custom tools (MCP) are not supported on mobile devices',
      mcpServers: 'MCP servers',
      addServer: 'Add custom tool server (MCP)',
      serverName: 'Server name',
      command: 'Command',
      server: 'Server',
      status: 'Status',
      enabled: 'Enabled',
      actions: 'Actions',
      noServersFound: 'No custom tool servers (MCP) found',
      tools: 'Tools',
      error: 'Error',
      connected: 'Connected',
      connecting: 'Connecting...',
      disconnected: 'Disconnected',
      autoExecute: 'Auto-execute',
      deleteServer: 'Delete custom tool server',
      deleteServerConfirm: 'Are you sure you want to delete custom tool server',
      edit: 'Edit',
      delete: 'Delete',
      expand: 'Expand',
      collapse: 'Collapse',
      addServerTitle: 'Add server',
      editServerTitle: 'Edit server',
      serverNameField: 'Name',
      serverNameFieldDesc: 'The name of the MCP server',
      serverNamePlaceholder: "e.g. 'github'",
      parametersField: 'Parameters',
      parametersFieldDesc:
        'JSON config for MCP server transport. Supported formats:\n- stdio: {"transport":"stdio","command":"npx","args":[...],"env":{...}}\n- http: {"transport":"http","url":"https://...","headers":{...}}\n- sse: {"transport":"sse","url":"https://...","headers":{...}}\n- ws: {"transport":"ws","url":"wss://..."}\nAlso supports wrapper formats: {"mcpServers": {"name": {...}}} and {"id":"name","parameters": {...}}',
      parametersFieldDescShort:
        'JSON config for the MCP server. Supports stdio, http, sse, ws transports.',
      parametersFormatHelp: 'Format help',
      parametersTooltipDesc:
        'Preferred:\n- stdio: {"transport":"stdio","command":"npx",...}\n- http/sse/ws: {"transport":"http|sse|ws","url":"..."}\n\nCompatible wrappers:\n- {"mcpServers": {"name": {...}}}\n- {"id":"name","parameters": {...}}\n\nTip: if mcpServers contains one server, Name will auto-fill.',
      parametersTooltipTitle: 'Format examples',
      parametersTooltipPreferred: 'Preferred',
      parametersTooltipCompatible: 'Compatible',
      parametersTooltipTip:
        'Tip: if mcpServers contains one server, Name will auto-fill.',
      serverNameRequired: 'Name is required',
      serverAlreadyExists: 'Server with same name already exists',
      parametersRequired: 'Parameters are required',
      parametersMustBeValidJson: 'Parameters must be valid JSON',
      invalidJsonFormat: 'Invalid JSON format',
      invalidParameters: 'Invalid parameters',
      validParameters: 'Valid parameters',
      failedToAddServer: 'Failed to add custom tool server (MCP).',
      failedToDeleteServer: 'Failed to delete server.',
    },
    templates: {
      title: 'Templates',
      desc: 'Create reusable prompt templates',
      howToUse:
        'Create templates with reusable content that you can quickly insert into your chat by typing /template-name in the chat input to trigger template insertion, or drag and select text in the chat input to reveal a "create template" button for quick template creation.',
      savedTemplates: 'Saved templates',
      addTemplate: 'Add prompt template',
      templateName: 'Template name',
      noTemplates: 'No templates found',
      loading: 'Loading templates...',
      deleteTemplate: 'Delete template',
      deleteTemplateConfirm: 'Are you sure you want to delete template',
      editTemplate: 'Edit template',
      name: 'Name',
      actions: 'Actions',
    },
    continuation: {
      title: 'Sparkle mode',
      aiSubsectionTitle: 'Super continuation',
      customSubsectionTitle: 'Smart space',
      tabSubsectionTitle: 'Tab completion',
      superContinuation: 'Enable sparkle view',
      superContinuationDesc:
        'Enable the sparkle sidebar view where you can configure dedicated continuation models, parameters, rules, and reference sources; when disabled, only the chat view is available.',
      continuationModel: 'Sparkle continuation model',
      continuationModelDesc:
        'Select the model used for continuation while sparkle mode is enabled.',
      smartSpaceDescription:
        'Smart space offers a lightweight floating composer while you write; by default it appears when you press the space key on an empty line or type “/” followed by space anywhere. You can switch below to double-space on empty lines or disable space-triggering. Press enter twice to submit and press escape to close.',
      smartSpaceToggle: 'Enable smart space',
      smartSpaceToggleDesc:
        'When disabled, the space bar or "/"+space will no longer summon the smart space floating composer.',
      smartSpaceTriggerMode: 'Empty-line space trigger',
      smartSpaceTriggerModeDesc:
        'How smart space should respond when you press space on an empty line.',
      smartSpaceTriggerModeSingle:
        'Single space to trigger (original behavior)',
      smartSpaceTriggerModeDouble:
        'Double space to trigger (~600ms; first space inserts a real space)',
      smartSpaceTriggerModeOff:
        'Disable empty-line space trigger (keep "/"+space only)',
      selectionChatSubsectionTitle: 'Cursor chat',
      selectionChatDescription:
        'Provides inline ask, rewrite, explain, and other quick actions around selected text.',
      selectionChatToggle: 'Enable cursor chat',
      selectionChatToggleDesc:
        'When enabled, selecting text shows quick actions so you can ask or run preset commands directly.',
      selectionChatAutoDock: 'Auto dock to top right',
      selectionChatAutoDockDesc:
        'After sending, move to the editor top right (manual drag disables auto follow).',
      keywordTrigger: 'Enable keyword trigger for AI continuation',
      keywordTriggerDesc:
        'Automatically trigger continuation when the specified keyword is detected in the editor; recommended value: cc.',
      triggerKeyword: 'Trigger keyword',
      triggerKeywordDesc:
        'Continuation is triggered when the text immediately before the cursor equals this keyword (default: cc).',
      quickAskSubsectionTitle: 'Quick ask',
      quickAskDescription:
        'Quick ask lets you ask questions directly in the editor. Type the trigger character (default @) on an empty line to open a floating chat panel, select an assistant, and get responses. Supports multi-turn conversations, copying answers, inserting at cursor, or opening in sidebar.',
      quickAskToggle: 'Enable quick ask',
      quickAskToggleDesc:
        'When disabled, the trigger character will no longer summon the quick ask floating panel.',
      quickAskTrigger: 'Trigger character',
      quickAskTriggerDesc:
        'Typing this character on an empty line triggers quick ask (default: @). Supports 1-3 characters.',
      quickAskContextBeforeChars: 'Context before cursor (chars)',
      quickAskContextBeforeCharsDesc:
        'Maximum characters before the cursor to include (default: 5000).',
      quickAskContextAfterChars: 'Context after cursor (chars)',
      quickAskContextAfterCharsDesc:
        'Maximum characters after the cursor to include (default: 2000).',
      tabCompletionBasicTitle: 'Basic settings',
      tabCompletionBasicDesc: 'Enable tab completion and set core parameters.',
      tabCompletionTriggersSectionTitle: 'Trigger settings',
      tabCompletionTriggersSectionDesc:
        'Configure when completion should fire.',
      tabCompletionAutoSectionTitle: 'Auto completion settings',
      tabCompletionAutoSectionDesc: 'Tune idle auto completion behavior.',
      tabCompletionAdvancedSectionDesc:
        'Configure advanced tab completion options.',
      tabCompletion: 'Enable tab completion',
      tabCompletionDesc:
        'Request a completion when a trigger rule matches, then show it as gray ghost text that can be accepted with the tab key.',
      tabCompletionModel: 'Completion model',
      tabCompletionModelDesc:
        'Choose which model provides tab completion suggestions.',
      tabCompletionTriggerDelay: 'Trigger delay (ms)',
      tabCompletionTriggerDelayDesc:
        'How long to wait after you stop typing before a prefix completion request is sent.',
      tabCompletionAutoTrigger: 'Auto completion after idle',
      tabCompletionAutoTriggerDesc:
        'Trigger tab completion after you stop typing, even when no trigger matches.',
      tabCompletionAutoTriggerDelay: 'Auto completion idle delay (ms)',
      tabCompletionAutoTriggerDelayDesc:
        'How long to wait after you stop typing before auto completion runs.',
      tabCompletionAutoTriggerCooldown: 'Auto completion cooldown (ms)',
      tabCompletionAutoTriggerCooldownDesc:
        'Cooldown period after auto completion triggers to avoid frequent requests.',
      tabCompletionMaxSuggestionLength: 'Max suggestion length',
      tabCompletionMaxSuggestionLengthDesc:
        'Cap the number of characters inserted when accepting a suggestion.',
      tabCompletionLengthPreset: 'Completion length',
      tabCompletionLengthPresetDesc:
        'Ask the model to keep the completion short, medium, or long.',
      tabCompletionLengthPresetShort: 'Short',
      tabCompletionLengthPresetMedium: 'Medium',
      tabCompletionLengthPresetLong: 'Long',
      tabCompletionAdvanced: 'Advanced settings',
      tabCompletionContextRange: 'Context range',
      tabCompletionContextRangeDesc:
        'Total characters of context sent to the model (split 4:1 between before and after cursor).',
      tabCompletionMinContextLength: 'Minimum context length',
      tabCompletionMinContextLengthDesc:
        'Skip tab completion unless the text before the cursor contains at least this many characters.',
      tabCompletionTemperature: 'Sampling temperature',
      tabCompletionTemperatureDesc:
        'Controls creativity for prefix suggestions (0 = deterministic, higher = more diverse).',
      tabCompletionRequestTimeout: 'Request timeout (ms)',
      tabCompletionRequestTimeoutDesc:
        'Abort a prefix completion request if it takes longer than this time.',
      tabCompletionConstraints: 'Tab completion constraints',
      tabCompletionConstraintsDesc:
        'Optional rules inserted into the tab completion prompt (for example, "write in another language" or "match a specific style").',
      tabCompletionTriggersTitle: 'Triggers',
      tabCompletionTriggersDesc:
        'Tab completion is triggered only when one of the enabled rules matches.',
      tabCompletionTriggerAdd: 'Add trigger',
      tabCompletionTriggerEnabled: 'Enabled',
      tabCompletionTriggerType: 'Type',
      tabCompletionTriggerTypeString: 'String',
      tabCompletionTriggerTypeRegex: 'Regex',
      tabCompletionTriggerPattern: 'Pattern',
      tabCompletionTriggerDescription: 'Description',
      tabCompletionTriggerRemove: 'Remove',
    },
    etc: {
      title: 'Other',
      resetSettings: 'Reset settings',
      resetSettingsDesc: 'Reset all settings to default values',
      resetSettingsConfirm:
        'Are you sure you want to reset all settings to default values without the ability to undo?',
      resetSettingsSuccess: 'Settings have been reset to defaults',
      reset: 'Reset',
      clearChatHistory: 'Clear chat history',
      clearChatHistoryDesc: 'Delete all chat conversations and messages',
      clearChatHistoryConfirm:
        'Are you sure you want to clear all chat history without the ability to undo?',
      clearChatHistorySuccess: 'All chat history has been cleared',
      clearChatSnapshots: 'Clear chat snapshots and cache',
      clearChatSnapshotsDesc:
        'Delete all conversation context snapshots, edit review snapshots, and timeline height cache files (without deleting chat messages)',
      clearChatSnapshotsConfirm:
        'Are you sure you want to clear all chat snapshot and cache files? This action cannot be undone and context and timeline heights may need to be rebuilt later.',
      clearChatSnapshotsSuccess:
        'All chat snapshot and cache files have been cleared',
      resetProviders: 'Reset providers and models',
      resetProvidersDesc: 'Restore default providers and model configurations',
      resetProvidersConfirm:
        'Are you sure you want to reset providers and models to defaults and overwrite the existing configuration?',
      resetProvidersSuccess: 'Providers and models have been reset to defaults',
      resetAgents: 'Reset agents',
      resetAgentsDesc:
        'Restore default agent configuration and remove custom agents',
      resetAgentsConfirm:
        'Are you sure you want to reset agent configuration? This will remove custom agents and reset the current selection.',
      resetAgentsSuccess: 'Agent configuration has been reset to defaults',
      logModelRequestContext: 'Log model request context',
      logModelRequestContextDesc:
        'Print the final request payload actually sent to the model for each Agent turn in the developer console.',
      yoloBaseDir: 'YOLO base folder',
      yoloBaseDirDesc:
        'Enter a vault-relative path (without a leading /). Example: use YOLO at vault root, or setting/YOLO under the setting folder. Current skills directory: {path}.',
      yoloBaseDirPlaceholder: 'YOLO',
      mentionDisplayMode: 'Mention display position',
      mentionDisplayModeDesc:
        'Choose whether @ file mentions and / skill selections are shown inline in the editor or as badges above the input box.',
      mentionDisplayModeInline: 'Inside input box',
      mentionDisplayModeBadge: 'Top badges',
      mentionContextMode: '@ file context injection mode',
      mentionContextModeDesc:
        'Control how @ files are injected into the model. In light mode, only the referenced file paths, note properties, and Markdown structure are injected, encouraging the Agent to read only what is necessary.',
      mentionContextModeLight: 'Light mode',
      mentionContextModeFull: 'Full mode',
      chatApplyMode: 'Chat apply behavior',
      chatApplyModeDesc:
        'Only affects Apply in the sidebar Chat. Choose whether edits open inline review first or write directly to the file. Turning review off skips the second confirmation step.',
      chatApplyModeReviewRequired: 'Review before apply',
      chatApplyModeDirectApply: 'Write directly to file',
      persistSelectionHighlight: 'Keep selection block highlight',
      persistSelectionHighlightDesc:
        'Keep showing the block highlight for selected editor content while interacting with sidebar Chat or Quick Ask.',
      notifications: 'Notifications',
      notificationsDesc:
        'Configure alerts for Agent runs. System notifications automatically degrade when the environment does not support them.',
      notificationsEnabled: 'Enable notifications',
      notificationsEnabledDesc: 'Turn task alerts on or off for Agent runs.',
      notificationChannel: 'Notification method',
      notificationChannelDesc:
        'Choose whether reminders use sound, system notifications, or both.',
      notificationChannelSound: 'Sound only',
      notificationChannelSystem: 'System only',
      notificationChannelBoth: 'Sound + system',
      notificationTiming: 'Notification timing',
      notificationTimingDesc:
        'Choose whether reminders always fire or only when Obsidian is unfocused.',
      notificationTimingAlways: 'Always notify',
      notificationTimingWhenUnfocused: 'Only when unfocused',
      notificationApprovalRequired: 'Notify when approval is required',
      notificationApprovalRequiredDesc:
        'Alert you when YOLO pauses and needs you to approve a tool call.',
      notificationTaskCompleted: 'Notify when a task finishes',
      notificationTaskCompletedDesc:
        'Alert you after the current Agent run finishes without waiting for more approvals.',
      interactionSectionTitle: 'Interaction',
      maintenanceSectionTitle: 'Maintenance',
      tabTitleFollowsConversation: 'Follow conversation title in tab',
      tabTitleFollowsConversationDesc:
        'When enabled, the Chat tab title shows the current conversation title. When disabled, it stays as Yolo chat.',
    },
  },

  chat: {
    placeholder:
      'Type a message...「@ to add references or models, / to choose a skill or command」',
    placeholderCompact: 'Click to expand and edit...',
    contextUsage: 'Context window usage',
    sendMessage: 'Send message',
    newChat: 'New chat',
    continueResponse: 'Continue response',
    stopGeneration: 'Stop generation',
    vaultSearch: 'Vault search',
    selectModel: 'Select model',
    uploadImage: 'Upload image',
    addContext: 'Add context',
    applyChanges: 'Apply changes',
    copyMessage: 'Copy message',
    createBranchFromHere: 'Create branch from here',
    branchCreated: 'Branch created',
    branchCreateFailed: 'Failed to create branch',
    insertAtCursor: 'Insert / Replace at cursor',
    insertSuccess: 'Message inserted into the active note',
    insertUnavailable: 'No active markdown editor found',
    noAssistantContent: 'No assistant content to insert',
    regenerate: 'Regenerate',
    reasoning: 'Reasoning',
    annotations: 'Annotations',
    assistantQuote: {
      add: 'Quote',
      badge: 'Reply quote',
    },
    mentionMenu: {
      back: 'Back',
      entryCurrentFile: 'Current file',
      entryMode: 'Mode',
      entrySkill: 'Skill',
      entryAssistant: 'Assistant',
      entryModel: 'Model',
      entryFile: 'File',
      entryFolder: 'Folder',
    },
    slashCommands: {
      compact: {
        label: 'Compact Context',
        description:
          'Manually compress earlier conversation history and continue the current task in a fresh context window.',
      },
    },
    emptyState: {
      chatTitle: 'Think first, then write',
      chatDescription:
        'Great for questions, polishing, and rewriting with focus on expression.',
      agentTitle: 'Let AI execute',
      agentDescription:
        'Enable tools to handle search, read/write operations, and multi-step tasks.',
    },
    compaction: {
      pendingTitle: 'Compacting context',
      dividerTitle: 'Continue the current task from here',
      dividerDescription:
        'Earlier conversation has been compressed into a summary. Replies below continue from that summary',
      dividerDescriptionWithEstimate:
        'Earlier conversation has been compressed into a summary. The next-round total context is estimated at about {count} tokens',
      pendingStatus:
        'Organizing context now. The conversation will continue in a fresh context shortly.',
      success:
        'Earlier context has been compressed. Future replies will continue from the summary.',
      failed: 'Context compaction failed. Please try again shortly.',
      empty: 'There is no conversation content to compact yet.',
      runActive:
        'Wait for the current reply to finish before compacting context.',
      waitingApproval:
        'Resolve the current pending tool approval before compacting context.',
      autoFailed:
        'Automatic context compaction failed. Sending with the previous context.',
    },
    codeBlock: {
      showRawText: 'Show raw text',
      showFormattedText: 'Show formatted text',
      copyText: 'Copy text',
      textCopied: 'Text copied',
      apply: 'Apply',
      applying: 'Applying...',
      locatingTarget: 'Locating and loading replacement content...',
      emptyPlanPreview: 'This plan removes content',
      stopApplying: 'Stop apply',
    },
    customContinuePromptLabel: 'Continuation instruction',
    customContinuePromptPlaceholder:
      'Ask AI (@ for files, # for quick actions)',
    customContinueHint: 'Press enter (⏎) to submit',
    customContinueConfirmHint: 'Press enter (⏎) again to confirm',
    customContinueProcessing: 'Thinking',
    customContinueError: 'Generation failed; please try again soon.',
    customContinueSections: {
      suggestions: {
        title: 'Suggestions',
        items: {
          continue: {
            label: 'Continue writing',
            instruction:
              'You are a helpful writing assistant; continue writing from the provided context without repeating or paraphrasing the context, match the tone, language, and style, and output only the continuation text.',
          },
        },
      },
      writing: {
        title: 'Writing',
        items: {
          summarize: {
            label: 'Add a summary',
            instruction: 'Write a concise summary of the current content.',
          },
          todo: {
            label: 'Add action items',
            instruction:
              'Generate a checklist of actionable next steps from the current context.',
          },
          flowchart: {
            label: 'Create a flowchart',
            instruction:
              'Turn the current points into a flowchart or ordered steps.',
          },
          table: {
            label: 'Organize into a table',
            instruction:
              'Convert the current information into a structured table with appropriate columns.',
          },
          freewrite: {
            label: 'Freewriting',
            instruction:
              'Start a fresh continuation in a creative style that fits the context.',
          },
        },
      },
      thinking: {
        title: 'Ideate & converse',
        items: {
          brainstorm: {
            label: 'Brainstorm ideas',
            instruction:
              'Suggest several fresh ideas or angles based on the current topic.',
          },
          analyze: {
            label: 'Analyze this section',
            instruction:
              'Provide a brief analysis highlighting key insights, risks, or opportunities.',
          },
          dialogue: {
            label: 'Ask follow-up questions',
            instruction:
              'Generate thoughtful questions that can deepen understanding of the topic.',
          },
        },
      },
      custom: {
        title: 'Custom',
      },
    },
    editSummary: {
      filesChanged: '{count} file(s) changed',
      undo: 'Undo',
      undoFile: 'Undo file change',
      undone: 'Undone',
      undoSuccess: "Undid this assistant turn's file changes.",
      undoPartial:
        'Some files were reverted, while others were skipped because they changed afterward.',
      undoUnavailable:
        'File contents have changed, so this turn cannot be safely undone.',
      undoFailed: 'Undo failed. Please try again.',
      fileMissing: 'The file no longer exists or has been moved.',
    },
    errorCard: {
      title: 'This response failed to generate',
    },
    customRewritePromptPlaceholder:
      'Describe how to rewrite the selected text, for example: "make it concise and active voice; keep markdown structure"; press Shift+Enter to confirm, Enter for a new line, and Escape to close.',
    toolCall: {
      status: {
        call: 'Call',
        rejected: 'Rejected',
        running: 'Running',
        failed: 'Failed',
        completed: 'Completed',
        aborted: 'Aborted',
        unknown: 'Unknown',
      },
      displayName: {
        fs_list: 'List files',
        fs_search: 'Search files',
        fs_read: 'Read files',
        fs_edit: 'Text editing',
        fs_file_ops: 'File Operation Toolset',
        memory_add: 'Add memory',
        memory_update: 'Update memory',
        memory_delete: 'Delete memory',
        open_skill: 'Open skill',
      },
      writeAction: {
        create_file: 'Create file',
        delete_file: 'Delete file',
        create_dir: 'Create folder',
        delete_dir: 'Delete folder',
        move: 'Move path',
      },
      readMode: {
        full: 'Full',
        linesSuffix: ' lines',
      },
      detail: {
        target: 'Target',
        scope: 'Scope',
        query: 'Query',
        path: 'Path',
        paths: 'paths',
      },
      parameters: 'Parameters',
      noParameters: 'No parameters',
      result: 'Result',
      error: 'Error',
      allow: 'Allow',
      reject: 'Reject',
      abort: 'Abort',
      alwaysAllowThisTool: 'Always allow this tool',
      allowForThisChat: 'Allow for this chat',
    },
    conversationSettings: {
      openAria: 'Conversation settings',
      chatMemory: 'Chat memory',
      maxContext: 'Maximum context',
      sampling: 'Sampling parameters',
      temperature: 'Temperature',
      topP: 'Top p',
      streaming: 'Streaming',
      vaultSearch: 'Vault search',
      useVaultSearch: 'Retrieval-augmented search',
      geminiTools: 'Gemini tools',
      webSearch: 'Web search',
      urlContext: 'URL context',
    },
    notification: {
      approvalTitle: 'YOLO needs your confirmation',
      approvalBody:
        'The current task is paused and waiting for you to approve a tool call.',
      completedTitle: 'YOLO task finished',
      completedBody:
        'The current Agent run has finished. You can come back to review the result.',
      completedErrorBody:
        'The current Agent run has ended. Please return to the window to inspect the result.',
    },
  },

  notices: {
    rebuildingIndex: 'Rebuilding vault index…',
    rebuildComplete: 'Rebuilding vault index complete.',
    rebuildFailed: 'Rebuilding vault index failed.',
    openYoloNewChatFailed:
      'Failed to open the YOLO chat window; try the command palette first.',
    pgliteUnavailable:
      'PGlite runtime unavailable; retry downloading the runtime assets.',
    downloadingPglite:
      'Downloading PGlite runtime assets; first-time knowledge base usage may take a moment…',
    updatingIndex: 'Updating vault index…',
    indexUpdated: 'Vault index updated.',
    indexUpdateFailed: 'Vault index update failed.',
    migrationComplete: 'Migration to JSON storage completed successfully.',
    migrationFailed:
      'Failed to migrate to JSON storage; please check the console for details.',
    reloadingPlugin: 'Reloading "next-composer" due to migration',
    settingsInvalid: 'Invalid settings',
    transportModeAutoPromoted:
      'Detected network/CORS issue. Automatically switched this provider to {mode}.',
  },

  statusBar: {
    agentRunningWithApproval:
      'There are currently {count} running agents ({approvalCount} awaiting approval)',
    agentRunning: 'There are currently {count} running agents',
    agentStatusAriaLabel: 'Agent status, click to view running conversations',
    agentStatusTitle:
      'Click to view running conversations and open one in a new chat tab',
    agentStatusPanelTitle: 'Active Agent conversations',
    agentStatusPanelEmpty: 'There are no running conversations to switch to',
    agentStatusRunning: 'Running',
    agentStatusWaitingApproval: 'Awaiting approval',
    agentStatusFallbackConversationTitle: 'Running conversation',
    backgroundStatusAriaLabel:
      'Background task status, click to inspect details',
    backgroundStatusPanelTitle: 'Background tasks',
    backgroundStatusPanelEmpty: 'There are no running background tasks',
    backgroundTasksRunning: 'There are currently {count} background tasks running',
    backgroundTasksNeedAttention: 'A background task needs attention',
    ragAutoUpdateRunning: 'Knowledge base updating in background',
    ragAutoUpdateRunningDetail:
      'Incrementally synchronizing the knowledge base index.',
    ragAutoUpdateFailed: 'Knowledge base auto-update failed',
    ragAutoUpdateFailedDetail:
      'The latest background sync failed. Please retry later.',
  },

  errors: {
    providerNotFound: 'Provider not found',
    modelNotFound: 'Model not found',
    invalidApiKey: 'Invalid API key',
    networkError: 'Network error',
    databaseError: 'Database error',
    mcpServerError: 'Server error',
  },

  applyView: {
    applying: 'Applying',
    reviewTitle: 'Review changes',
    changesResolved: 'Changes resolved',
    acceptAllIncoming: 'Accept all incoming',
    keepAllChanges: 'Keep all changes',
    rejectAll: 'Reject all',
    revertAllChanges: 'Revert all changes',
    prevChange: 'Previous change',
    nextChange: 'Next change',
    reset: 'Reset',
    applyAndClose: 'Apply & close',
    acceptIncoming: 'Accept incoming',
    keepChange: 'Keep this change',
    acceptCurrent: 'Accept current',
    revertChange: 'Revert this change',
    acceptBoth: 'Accept both',
    acceptedIncoming: 'Accepted incoming',
    keptChange: 'Kept this change',
    keptCurrent: 'Kept current',
    revertedChange: 'Reverted this change',
    mergedBoth: 'Merged both',
    undo: 'Undo',
  },

  quickAsk: {
    selectAssistant: 'Select an assistant',
    noAssistant: 'No assistant',
    noAssistantDescription: 'Use default system prompt',
    navigationHint: 'Use ↑/↓ to navigate, enter to select, esc to cancel',
    inputPlaceholder: 'Ask a question...',
    close: 'Close',
    copy: 'Copy',
    insert: 'Insert',
    openInSidebar: 'Open in sidebar',
    stop: 'Stop',
    send: 'Send',
    clear: 'Clear conversation',
    clearConfirm: 'Are you sure you want to clear the current conversation?',
    cleared: 'Conversation cleared',
    error: 'Failed to generate response',
    copied: 'Copied to clipboard',
    inserted: 'Inserted at cursor',
    // Mode select
    modeAsk: 'Ask',
    modeEdit: 'Edit',
    modeEditDirect: 'Edit (full access)',
    modeAskDesc: 'Ask questions and get answers',
    modeEditDesc: 'Edit the current document',
    modeEditDirectDesc: 'Edit document directly without confirmation',
    editNoFile: 'Please open a file first',
    editNoChanges: 'No valid changes returned by model',
    editPartialSuccess:
      'Applied {appliedCount} of {totalEdits} edits. Check console for details.',
    editApplied: 'Successfully applied {appliedCount} edit(s) to {fileName}',
    statusRequesting: 'Requesting...',
    statusThinking: 'Thinking...',
    statusGenerating: 'Generating...',
    statusModifying: 'Modifying...',
  },

  chatMode: {
    chat: 'Chat',
    chatDesc: 'Ask, refine, create',
    rewrite: 'Rewrite',
    rewriteDesc: 'Only modify the current selection',
    agent: 'Agent',
    agentDesc: 'Tools for complex tasks',
    warning: {
      title: 'Please confirm before enabling Agent mode',
      description:
        'Agent can automatically invoke tools. Please review the following risks before continuing:',
      permission:
        'Strictly control tool-call permissions and grant only what is necessary.',
      cost: 'Agent tasks may consume significant model resources and incur higher costs.',
      backup:
        'Back up important content in advance to avoid unintended changes.',
      checkbox:
        'I understand the risks above and accept responsibility for proceeding',
      cancel: 'Cancel',
      confirm: 'Continue and Enable Agent',
    },
  },

  reasoning: {
    selectReasoning: 'Select reasoning',
    off: 'Off',
    on: 'On',
    auto: 'Auto',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    extraHigh: 'Extra high',
  },

  update: {
    newVersionAvailable: 'New version {version} is available',
    currentVersion: 'Current',
    viewDetails: 'Check for updates',
    dismiss: 'Dismiss',
  },
}
