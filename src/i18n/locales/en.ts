import { TranslationKeys } from '../types'

export const en: TranslationKeys = {
  commands: {
    openChat: 'Open chat',
    addSelectionToChat: 'Add selection to chat',
    addFileToChat: 'Add file to chat',
    addFolderToChat: 'Add folder to chat',
    rebuildVaultIndex: 'Rebuild entire vault index',
    updateVaultIndex: 'Update index for modified files',
    continueWriting: 'AI continue writing',
    continueWritingSelected: 'AI continue writing (selection)',
    customContinueWriting: 'AI custom continue',
    customRewrite: 'AI custom rewrite',
  },

  common: {
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    add: 'Add',
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
    default: 'Default',
    on: 'On',
    off: 'Off',
    noResults: 'No matches found',
  },

  sidebar: {
    tabs: {
      chat: 'Chat',
      composer: 'Sparkle',
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
      rewrite: 'AI rewrite',
      explain: 'Explain in depth',
    },
  },

  settings: {
    title: 'Yolo settings',
    supportSmartComposer: {
      name: 'Support the project',
      desc: 'If you find this plugin valuable, consider supporting its development!',
      buyMeACoffee: 'Buy me a coffee',
    },
    defaults: {
      title: 'Default models & prompts',
      defaultChatModel: 'Default chat model',
      defaultChatModelDesc:
        'Choose the model you want to use for sidebar chat.',
      toolModel: 'Tool model',
      toolModelDesc:
        'Select the model used globally as the tool model (for auto conversation naming, apply operations, etc.).',
      globalSystemPrompt: 'Global system prompt',
      globalSystemPromptDesc:
        'This prompt is added to the beginning of every chat conversation.',
      continuationSystemPrompt: 'Default continuation system prompt',
      continuationSystemPromptDesc:
        'Used as the system message when generating continuation text; leave empty to fall back to the built-in default.',
      chatTitlePrompt: 'Chat title prompt',
      chatTitlePromptDesc:
        'Prompt used when automatically generating conversation titles from the first user message.',
      baseModelSpecialPrompt: 'Base model special prompt',
      baseModelSpecialPromptDesc: 'Special prompt words used as base model.',
      tabCompletionSystemPrompt: 'Tab completion system prompt',
      tabCompletionSystemPromptDesc:
        'System message applied when generating tab completion suggestions; leave empty to use the built-in default.',
    },
    smartSpace: {
      quickActionsTitle: 'Smart space quick actions',
      quickActionsDesc:
        'Customize the quick actions and prompts displayed in smart space',
      addAction: 'Add action',
      resetToDefault: 'Reset to default',
      confirmReset:
        'Are you sure you want to reset to default quick actions and delete all custom settings?',
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
    chatPreferences: {
      title: 'Chat preferences',
      includeCurrentFile: 'Auto-include current page',
      includeCurrentFileDesc:
        'Automatically include the content of your current file in chats.',
      enableTools: 'Enable tools',
      enableToolsDesc: 'Allow the AI to use MCP tools.',
      maxAutoIterations: 'Max auto tool requests',
      maxAutoIterationsDesc:
        'Maximum number of consecutive tool calls that can be made automatically without user confirmation; higher values can significantly increase costs as each tool call consumes additional tokens.',
      maxContextMessages: 'Max context messages',
      maxContextMessagesDesc:
        'Number of previous chat messages to include in each request (0 to include none); 32 is recommended (about 16 user-assistant turns).',
      defaultTemperature: 'Default temperature',
      defaultTemperatureDesc:
        'Default temperature for new conversations (0.0-2.0); leave empty to use the model default.',
      defaultTopP: 'Default top p',
      defaultTopPDesc:
        'Default top p for new conversations (0.0-1.0); leave empty to use the model default.',
    },
    assistants: {
      title: 'Assistants',
      desc: 'Create and manage custom AI assistants',
      addAssistant: 'Add assistant',
      editAssistant: 'Edit assistant',
      deleteAssistant: 'Delete assistant',
      name: 'Name',
      description: 'Description',
      systemPrompt: 'System prompt',
      systemPromptDesc:
        'This prompt will be added to the beginning of every chat.',
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
    providers: {
      title: 'Providers',
      desc: 'Enter your API keys for the providers you want to use',
      howToGetApiKeys: 'How to obtain API keys',
      addProvider: 'Add provider',
      editProvider: 'Edit provider',
      deleteProvider: 'Delete provider',
      deleteConfirm: 'Are you sure you want to delete provider',
      deleteWarning: 'This will also delete',
      chatModels: 'Chat models',
      embeddingModels: 'Embedding models',
      embeddingsWillBeDeleted:
        'All embeddings generated using the related embedding models will also be deleted.',
      addCustomProvider: 'Add custom provider',
      editProviderTitle: 'Edit provider',
      providerId: 'ID',
      providerIdDesc:
        'Choose an ID to identify this provider in your settings. This is just for your reference.',
      providerIdPlaceholder: 'my-custom-provider',
      apiKey: 'API key',
      apiKeyDesc: '(Leave empty if not required)',
      apiKeyPlaceholder: 'Enter your API key',
      baseUrl: 'Base URL',
      baseUrlDesc:
        'API endpoint for third-party services, e.g.: https://api.example.com/v1 or https://your-proxy.com/openai (Leave empty to use default)',
      baseUrlPlaceholder: 'https://api.example.com/v1',
      noStainlessHeaders: 'No stainless headers',
      noStainlessHeadersDesc:
        'Enable this if you encounter CORS errors related to stainless headers (x-stainless-os, etc.)',
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
      modelIdPlaceholder: 'gpt-4o-mini',
      modelName: 'Display name',
      modelNamePlaceholder: 'Enter a display name',
      availableModelsAuto: 'Available models (auto-fetched)',
      searchModels: 'Search models...',
      fetchModelsFailed: 'Failed to fetch models',
      embeddingModelsFirst: 'Embedding models are listed first',
      reasoningType: 'Model type',
      reasoningTypeNone: 'No special configuration',
      reasoningTypeOpenAI: 'OpenAI reasoning (o3 / o4-mini / gpt-5)',
      reasoningTypeGemini: 'Gemini reasoning (2.5 pro / flash / flash-lite)',
      reasoningTypeBase: 'Special: base model',
      baseModelWarning:
        'When enabled, no system prompts (including assistant prompts) will be injected for this model; enable only if you understand how base models behave.',
      openaiReasoningEffort: 'Reasoning effort',
      openaiReasoningEffortDesc:
        'Choose effort: minimal (gpt-5 only) / low / medium / high',
      geminiThinkingBudget: 'Thinking budget (thinkingBudget)',
      geminiThinkingBudgetDesc:
        'Unit: thinking tokens. 0=off (Flash/Flash-Lite), -1=dynamic; ranges vary by model.',
      geminiThinkingBudgetPlaceholder: 'For example, -1 (dynamic, 0=off)',
      toolType: 'Tool type',
      toolTypeDesc: 'Select the tool type supported by the model',
      toolTypeNone: 'No tools',
      toolTypeGemini: 'Gemini tools',
      customParameters: 'Custom parameters',
      customParametersDesc:
        'Attach additional request fields; values accept plain text or JSON (for example, {"thinking": {"type": "enabled"}}).',
      customParametersAdd: 'Add parameter',
      customParametersKeyPlaceholder: 'Key, for example, thinking',
      customParametersValuePlaceholder:
        'Value in plain text or JSON; for example, {"type":"enabled"} or 0.7',
      dimension: 'Dimension',
      dimensionDesc: 'The dimension of the embedding model (optional)',
      dimensionPlaceholder: '1536',
      noChatModelsConfigured: 'No chat models configured',
      noEmbeddingModelsConfigured: 'No embedding models configured',
    },
    rag: {
      title: 'RAG (retrieval augmented generation)',
      enableRag: 'Show RAG settings',
      enableRagDesc:
        'Toggle visibility of the retrieval-augmented generation options below.',
      embeddingModel: 'Embedding model',
      embeddingModelDesc: 'Choose the model you want to use for embeddings',
      chunkSize: 'Chunk size',
      chunkSizeDesc:
        "Set the chunk size for text splitting. After changing this, please re-index the vault using the 'Rebuild entire vault index' command.",
      thresholdTokens: 'Threshold tokens',
      thresholdTokensDesc:
        'Maximum number of tokens before switching to RAG; if the total tokens from mentioned files exceed this, the plugin uses RAG instead of including all file contents.',
      minSimilarity: 'Minimum similarity',
      minSimilarityDesc:
        'Minimum similarity score for RAG results; higher values return more relevant but potentially fewer results.',
      limit: 'Limit',
      limitDesc:
        'Maximum number of RAG results to include in the prompt; higher values provide more context but increase token usage.',
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
        'Tip: No include folders are selected, so all are included by default; if exclude folders are set, exclusion takes precedence.',
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
      // Index progress header/status
      indexProgressTitle: 'RAG index progress',
      indexing: 'In progress',
      notStarted: 'Not started',
    },
    mcp: {
      title: 'Model Context Protocol (MCP)',
      desc: 'Configure MCP servers to extend AI capabilities',
      warning:
        'When using tools, the tool response is passed to the language model (LLM); if the tool result contains a large amount of content, this can significantly increase LLM usage and associated costs, so please be mindful when enabling or using tools that may return long outputs.',
      notSupportedOnMobile: 'MCP is not supported on mobile devices',
      mcpServers: 'MCP servers',
      addServer: 'Add server',
      serverName: 'Server name',
      command: 'Command',
      server: 'Server',
      status: 'Status',
      enabled: 'Enabled',
      actions: 'Actions',
      noServersFound: 'No MCP servers found',
      tools: 'Tools',
      error: 'Error',
      connected: 'Connected',
      connecting: 'Connecting...',
      disconnected: 'Disconnected',
      autoExecute: 'Auto-execute',
      deleteServer: 'Delete server',
      deleteServerConfirm: 'Are you sure you want to delete server',
      edit: 'Edit',
      delete: 'Delete',
      expand: 'Expand',
      collapse: 'Collapse',
      validParameters: 'Valid parameters',
      failedToAddServer: 'Failed to add MCP server.',
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
      smartSpaceTriggerModeSingle: 'Single space to trigger (original behavior)',
      smartSpaceTriggerModeDouble:
        'Double space to trigger (~600ms; first space inserts a real space)',
      smartSpaceTriggerModeOff:
        'Disable empty-line space trigger (keep "/"+space only)',
      selectionChatToggle: 'Enable cursor chat',
      selectionChatToggleDesc:
        'Show a small indicator at the bottom-right of selected text with actions (add to chat, AI rewrite, explain in depth).',
      keywordTrigger: 'Enable keyword trigger for AI continuation',
      keywordTriggerDesc:
        'Automatically trigger continuation when the specified keyword is detected in the editor; recommended value: cc.',
      triggerKeyword: 'Trigger keyword',
      triggerKeywordDesc:
        'Continuation is triggered when the text immediately before the cursor equals this keyword (default: cc).',
      quickAskSubsectionTitle: 'Quick Ask',
      quickAskDescription:
        'Quick Ask lets you ask questions directly in the editor. Type the trigger character (default @) on an empty line to open a floating chat panel, select an assistant, and get AI responses. Supports multi-turn conversations, copying answers, inserting at cursor, or opening in sidebar.',
      quickAskToggle: 'Enable Quick Ask',
      quickAskToggleDesc:
        'When disabled, the trigger character will no longer summon the Quick Ask floating panel.',
      quickAskTrigger: 'Trigger character',
      quickAskTriggerDesc:
        'Typing this character on an empty line triggers Quick Ask (default: @). Supports 1-3 characters.',
      tabCompletion: 'Enable tab completion',
      tabCompletionDesc:
        'After a 3-second pause, request a prefix completion and show it as gray ghost text that can be accepted with the tab key.',
      tabCompletionModel: 'Completion model',
      tabCompletionModelDesc:
        'Choose which model provides tab completion suggestions.',
      tabCompletionTriggerDelay: 'Trigger delay (ms)',
      tabCompletionTriggerDelayDesc:
        'How long to wait after you stop typing before a prefix completion request is sent.',
      tabCompletionMinContextLength: 'Minimum context length',
      tabCompletionMinContextLengthDesc:
        'Skip tab completion unless the text before the cursor contains at least this many characters.',
      tabCompletionMaxContextChars: 'Max context characters',
      tabCompletionMaxContextCharsDesc:
        'Limit how many recent characters are sent to the model for prefix completion.',
      tabCompletionMaxSuggestionLength: 'Max suggestion length',
      tabCompletionMaxSuggestionLengthDesc:
        'Cap the number of characters inserted when accepting a suggestion.',
      tabCompletionMaxTokens: 'Max tokens',
      tabCompletionMaxTokensDesc:
        'Limit the number of tokens requested from the model for each prefix completion call.',
      tabCompletionTemperature: 'Sampling temperature',
      tabCompletionTemperatureDesc:
        'Controls creativity for prefix suggestions (0 = deterministic, higher = more diverse).',
      tabCompletionRequestTimeout: 'Request timeout (ms)',
      tabCompletionRequestTimeoutDesc:
        'Abort a prefix completion request if it takes longer than this time.',
      tabCompletionMaxRetries: 'Retry count',
      tabCompletionMaxRetriesDesc:
        'Automatically retry timed-out prefix completion requests up to this many times.',
    },
    etc: {
      title: 'Etc',
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
      resetProviders: 'Reset providers and models',
      resetProvidersDesc: 'Restore default providers and model configurations',
      resetProvidersConfirm:
        'Are you sure you want to reset providers and models to defaults and overwrite the existing configuration?',
      resetProvidersSuccess: 'Providers and models have been reset to defaults',
    },
    // Modular System Prompt
    systemPrompt: {
      title: 'Global System Prompt',
      desc: 'Manage modular system prompts, organize and reuse different prompt components',
      modularMode: 'Modular Mode',
      previewMode: 'Preview Mode',
      addGroup: 'Add prompt group',
      addPrompt: 'Add prompt',
      defaultGroupName: 'New Group',
      defaultPromptName: 'New Prompt',
      defaultPromptContent: 'Please enter prompt content...',
      groupNamePlaceholder: 'Group name',
      promptNamePlaceholder: 'Prompt name',
      promptContentPlaceholder: 'Enter prompt content...',
      editPrompt: 'Edit Prompt',
      editGroupName: 'Click to edit group name',
      editPromptName: 'Click to edit prompt name',
      editPromptContent: 'Enter prompt content for editing...',
      editingTips: 'Editing Tips',
      tip1: 'Ctrl/Cmd + S: Save',
      tip2: 'Ctrl/Cmd + Enter: Save and close',
      tip3: 'Esc: Cancel and close',
      tip4: 'Supports multiline text and formatted content',
      wordCount: 'Word count',
      charCount: 'Characters',
      reset: 'Reset',
      confirmResetContent: 'Are you sure you want to reset to original content?',
      confirmDiscardChanges: 'Are you sure you want to discard current changes?',
      confirmDeleteGroup: 'Are you sure you want to delete this group and all its prompts?',
      confirmDeletePrompt: 'Are you sure you want to delete this prompt?',
      deleteGroup: 'Delete group',
      deletePrompt: 'Delete prompt',
      enabledPrompts: '{enabled}/{total}',
      noPrompts: 'No prompts available',
      enableGroup: 'Enable group',
      disableGroup: 'Disable group',
      enablePrompt: 'Enable prompt',
      disablePrompt: 'Disable prompt',
      // Table headers
      promptName: 'Prompt Name',
      enable: 'Enable',
      actions: 'Actions',
    },
    // System Prompt Preview
    systemPreview: {
      title: 'Preview Mode',
      previewContent: 'System Prompt Preview',
      previewDesc: 'This is the final content composed from all enabled prompt modules in order',
      previewEmpty: 'No enabled prompt modules',
      copyToClipboard: 'Copy to clipboard',
      copied: 'Copied',
      previewTip: 'Tip: This content will be sent to AI model as system prompt',
      totalChars: 'Total characters',
      totalWords: 'Total words',
      totalLines: 'Total lines',
      chineseChars: 'Chinese',
      englishWords: 'English',
    },
    language: {
      title: 'Language',
      select: 'Select language',
    },
  },

  chat: {
    placeholder: 'Ask anything about your vault...',
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
    regenerate: 'Regenerate',
    reasoning: 'Reasoning',
    annotations: 'Annotations',
    // System prompt related
    systemPrompt: {
      toggleTitle: 'Manage System Prompts',
      toggleAria: 'Open system prompt settings',
      title: 'System Prompts',
      description: 'Manage system prompt modules used in current conversation',
      empty: 'No system prompts available',
      hasChanges: 'You have unsaved changes',
      applyChanges: 'Apply Changes',
      discardChanges: 'Discard Changes',
      groupStats: '{enabled}/{total}',
      searchPlaceholder: 'Search prompts...',
      noResults: 'No matching prompts found',
      resetToDefault: 'Reset to Default',
      confirmReset: 'Are you sure you want to reset all prompts to default state?',
      enableGroup: 'Enable Group',
      disableGroup: 'Disable Group',
      enablePrompt: 'Enable Prompt',
      disablePrompt: 'Disable Prompt',
      allEnabled: 'All Enabled',
      allDisabled: 'All Disabled',
      partiallyEnabled: 'Partially Enabled',
      selectAll: 'Select All',
      deselectAll: 'Deselect All',
      expandAll: 'Expand All',
      collapseAll: 'Collapse All',
      previewTitle: 'Preview',
    },
    codeBlock: {
      showRawText: 'Show raw text',
      showFormattedText: 'Show formatted text',
      copyText: 'Copy text',
      textCopied: 'Text copied',
      apply: 'Apply',
      applying: 'Applying...',
    },
    customContinuePromptLabel: 'Continuation instruction',
    customContinuePromptPlaceholder: 'Ask AI (@ to attach files)',
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
    customRewritePromptPlaceholder:
      'Describe how to rewrite the selected text, e.g., "make it concise and active voice; keep markdown structure"; press shift+enter to confirm, enter for a new line, and escape to close.',
    conversationSettings: {
      openAria: 'Conversation settings',
      chatMemory: 'Chat memory',
      maxContext: 'Max context',
      sampling: 'Sampling parameters',
      temperature: 'Temperature',
      topP: 'Top p',
      streaming: 'Streaming',
      vaultSearch: 'Vault search',
      useVaultSearch: 'RAG search',
      geminiTools: 'Gemini tools',
      webSearch: 'Web search',
      urlContext: 'URL context',
    },
  },

  notices: {
    rebuildingIndex: 'Rebuilding vault index…',
    rebuildComplete: 'Rebuilding vault index complete.',
    rebuildFailed: 'Rebuilding vault index failed.',
    pgliteUnavailable:
      'PGlite resources unavailable; please check your network connection.',
    downloadingPglite:
      'Downloading PGlite dependencies from CDN (~20MB); this may take a moment…',
    updatingIndex: 'Updating vault index…',
    indexUpdated: 'Vault index updated.',
    indexUpdateFailed: 'Vault index update failed.',
    migrationComplete: 'Migration to JSON storage completed successfully.',
    migrationFailed:
      'Failed to migrate to JSON storage; please check the console for details.',
    reloadingPlugin: 'Reloading "next-composer" due to migration',
    settingsInvalid: 'Invalid settings',
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
    changesResolved: 'changes resolved',
    acceptAllIncoming: 'Accept All Incoming',
    rejectAll: 'Reject All',
    reset: 'Reset',
    applyAndClose: 'Apply & Close',
    acceptIncoming: 'Accept incoming',
    acceptCurrent: 'Accept current',
    acceptBoth: 'Accept both',
    acceptedIncoming: 'Accepted incoming',
    keptCurrent: 'Kept current',
    mergedBoth: 'Merged both',
    undo: 'Undo',
  },

  quickAsk: {
    selectAssistant: 'Select an assistant',
    noAssistant: 'No Assistant',
    noAssistantDescription: 'Use default system prompt',
    navigationHint: '↑↓ to navigate, Enter to select, Esc to cancel',
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
    modeEditDirect: 'Edit (Full Access)',
    modeAskDesc: 'Ask questions and get answers',
    modeEditDesc: 'Edit the current document',
    modeEditDirectDesc: 'Edit document directly without confirmation',
    editNoFile: 'Please open a file first',
    editNoChanges: 'No valid changes returned by model',
    editPartialSuccess: 'Applied ${appliedCount} of ${blocks.length} edits. Check console for details.',
    editApplied: 'Successfully applied ${appliedCount} edit(s) to ${activeFile.name}',
  },
}
