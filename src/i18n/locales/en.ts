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
    triggerQuickAskContinue: 'Trigger quick ask (continue writing)',
    triggerQuickAsk: 'Trigger quick ask',
    triggerTabCompletion: 'Trigger tab completion',
    acceptInlineSuggestion: 'Accept completion',
    capturePdfRegion: 'Capture PDF region to chat',
    exportSettings: 'Export plugin settings',
    importSettings: 'Import plugin settings',
    toggleVoiceInput: 'Toggle context-aware voice input',
    cancelVoiceInput: 'Cancel context-aware voice input',
    readAloudSelection: 'Read selection aloud',
    readAloudCurrentFile: 'Read current file aloud',
    stopReadAloud: 'Stop read aloud',
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
    switchSuggestion: '↑↓ Switch suggestion',
    copy: 'Copy',
    paste: 'Paste',
    characters: 'Chars',
    words: 'Words',
    wordsCharacters: 'Words/characters',
    rows: 'rows',
    columns: 'columns',
    default: 'Default',
    modelDefault: 'Model default',
    on: 'On',
    off: 'Off',
    noResults: 'No matches found',
    configure: 'Configure',
  },

  sidebar: {
    tabs: {
      chat: 'Chat',
      agent: 'Agent',
      composer: 'Sparkle',
    },
    runtimeSelector: {
      modeAccessibleLabel: 'Chat mode',
      chatLabel: 'Agent',
      cliLabel: 'CLI',
      chatDescription: 'Built-in YOLO chat',
      cliDescription: 'Use CLI for tasks',
      accessibleLabel: 'CLI provider: {runtime}',
      menuLabel: 'CLI provider',
      claudeCodeLabel: 'Claude Code',
      claudeCodeShortLabel: 'CC',
      claudeCodeDescription: 'Claude Code on this device',
      codexLabel: 'Codex',
      codexDescription: 'Codex on this device',
    },
    chatList: {
      searchPlaceholder: 'Search conversations',
      empty: 'No conversations',
      noTaskConversations: 'No task conversations',
      historySections: 'Conversation categories',
      myConversations: 'My conversations',
      taskConversations: 'Task conversations',
      taskConversationSources: 'Task conversation sources',
      allSources: 'All',
      externalAgent: 'External Agent',
      current: 'Current',
      pinConversation: 'Pin',
      unpinConversation: 'Unpin',
      retryTitle: 'Retry title',
      archived: 'Archived',
      hideArchived: 'Hide archived',
      exportConversation: 'Export conversation to vault',
      moreActions: 'More actions',
      confirmDelete: 'Click again to delete',
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
      referenceRulesPlaceholder:
        'Select folders whose content should be fully injected.',
      knowledgeBaseTitle: 'Knowledge base',
      knowledgeBasePlaceholder:
        'Select folders or files used as the retrieval scope (leave empty for all).',
      knowledgeBaseHint:
        'Enable embedding search to limit the retrieval scope.',
    },
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
    length: {
      adjust: 'Adjust length',
      condense: 'Condense',
      expand: 'Expand',
      freeExpand: 'Free expand',
      handle: 'Drag to adjust length',
      noEditor: 'Unable to access the current editor',
      noSelection: 'Select text to adjust first.',
      noEditorView: 'Unable to access the editor view',
      tableUnsupported: 'Table selections cannot be adjusted yet.',
    },
  },

  settings: {
    title: 'Yolo settings',
    tabs: {
      models: 'Models',
      voice: 'Voice',
      editor: 'Sparkle',
      knowledge: 'Knowledge',
      tools: 'Tools',
      agent: 'Agent',
      modules: 'Modules',
      others: 'Others',
    },
    supportYolo: {
      name: 'Support the project',
      desc: 'If you find this plugin valuable, consider supporting its development!',
      buyMeACoffee: 'Buy me a coffee',
      reportBug: 'Report Bug',
      featureRequest: 'Feature Request',
    },
    defaults: {
      title: 'Default model policies & prompts',
      defaultChatModel: 'Default chat model',
      defaultChatModelDesc:
        'Choose the model you want to use for sidebar chat.',
      chatTitleModel: 'Conversation title model',
      chatTitleModelDesc:
        'Choose the model used for automatic conversation naming.',
      streamFallbackRecovery: 'Enable automatic recovery',
      streamFallbackRecoveryDesc:
        'When the streaming primary request times out or fails, retry once with a non-streaming fallback.',
      primaryRequestTimeout: 'Primary request timeout (seconds)',
      primaryRequestTimeoutDesc:
        'How long to wait before the streaming primary request is treated as timed out. This timeout always applies; if automatic recovery is enabled, a non-streaming fallback is attempted afterward. Default: 60 seconds.',
      globalSystemPrompt: 'Global system prompt',
      globalSystemPromptDesc:
        'This prompt is added to the beginning of every chat conversation.',
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
    modules: {
      title: 'Modules',
      description:
        'View optional Yolo capabilities and their current runtime status.',
      manage: 'Manage modules',
      manageDescription:
        'Install YOLO capabilities and check whether they are ready to use.',
      navigation: 'Module settings navigation',
      enabled: 'Enabled',
      enabledEmpty: 'No modules are enabled.',
      disabled: 'Disabled',
      disabledEmpty: 'No modules are disabled.',
      settings: 'Settings',
      updateAndEnable: 'Update and enable',
      loading: 'Loading modules…',
      loadError: 'Modules could not be loaded.',
      settingsSaveError: 'Unable to save module settings',
      catalogError: 'Catalog: {error}',
      installedError: 'Installed modules: {error}',
      intentError: 'Module intent: {error}',
      empty: 'No modules were found.',
      installed: 'Installed',
      installedDescription: 'Modules currently present in this installation.',
      installedEmpty: 'No modules are installed.',
      available: 'Available',
      availableDescription: 'Modules available to this Yolo installation.',
      availableEmpty: 'No additional modules are available.',
      version: 'Version {version}',
      availableVersion: 'Update {version}',
      install: 'Install',
      update: 'Update',
      installing: 'Installing…',
      updating: 'Updating…',
      reload: 'Retry',
      reloading: 'Retrying…',
      candidateUnavailable:
        '{name} cannot be installed right now. It may already be downloading or the catalog may have changed.',
      installError: 'Could not install {name}: {error}',
      updateError: 'Could not update {name}: {error}',
      activationPendingDetail:
        'Version {version} is prepared and can be activated again.',
      intentLabel: 'Intent',
      intentUnknown: 'Unavailable',
      intentInstalledEnabled: 'Installed · enabled',
      intentInstalledDisabled: 'Installed · disabled',
      intentUninstalled: 'Not installed',
      readinessLabel: 'Readiness',
      readiness: {
        notInstalled: 'Not installed',
        pending: 'Pending or needs retry',
        ready: 'Ready on this device',
        failed: 'Failed',
      },
      incompatibleReason: 'Incompatible: {reason}',
      compatibility: {
        platform: 'platform',
        hostApi: 'update YOLO Core',
        dataSchema: 'data schema',
      },
      retry: 'Retry',
      actionError: 'Could not change {name}: {error}',
      failure: {
        downloadTimeout:
          'The module download timed out on both Cloudflare and GitHub. Check your network or proxy, then retry.',
        download:
          'The module could not be downloaded from Cloudflare or GitHub. Check your network or proxy, then retry.',
        integrity:
          'The downloaded module failed its integrity check, so installation was stopped. Retry, and contact the developer if it keeps happening.',
        activation:
          'The module was downloaded but could not start. Retry, and contact the developer if it keeps happening.',
        unknown: 'The module operation failed.',
        diagnostic: 'Details: {detail}',
      },
      actions: {
        install: 'Install',
        installBusy: 'Installing…',
        enable: 'Enable',
        enableBusy: 'Enabling…',
        disable: 'Disable',
        disableBusy: 'Disabling…',
        uninstall: 'Uninstall',
        uninstallBusy: 'Uninstalling…',
      },
      statuses: {
        available: 'Available',
        installed: 'Installed',
        active: 'Active',
        disabled: 'Disabled',
        updateAvailable: 'Update available',
        activationPending: 'Activation pending',
        failed: 'Failed',
      },
      runtimeComponents: {
        title: 'Runtime components',
        description: 'These components support certain YOLO features.',
        tokenizer: {
          name: 'Tokenizer',
          description: 'Counts context and tool tokens for Agent workflows.',
          impact: 'Turning this off disables accurate token budgeting.',
        },
        pdfEngine: {
          name: 'PDF engine',
          description: 'Extracts text, renders pages, and prepares PDF ranges.',
          impact: 'Turning this off disables PDF reading and page tools.',
        },
        pgliteEngine: {
          name: 'PGlite engine',
          description: 'Stores and searches the local knowledge-base index.',
          impact: 'Turning this off disables indexing and semantic search.',
        },
        bashEngine: {
          name: 'Bash engine',
          description:
            'Provides a virtual shell for the bash tool to search and organize vault files.',
          impact:
            'Turning this off disables the bash tool; the model loses vault search and file organization.',
        },
        statuses: {
          missing: 'Waiting to install',
          downloading: 'Downloading',
          ready: 'Ready',
          loading: 'Loading',
          active: 'In use',
          quiescing: 'Finishing current work',
          disabled: 'Disabled',
          failed: 'Failed',
        },
      },
    },
    smartSpace: {
      quickActionsTitle: 'Continue writing presets',
      quickActionsDesc:
        'Customize the quick actions and prompts shown in Quick Ask’s continue mode',
      quickActionsModalTitle: 'Quick Ask continuation presets',
      configureActions: 'Configure quick actions',
      actionsCount: 'Configured {count} quick actions',
      addAction: 'Add action',
      resetToDefault: 'Reset to default',
      confirmReset:
        'Are you sure you want to reset to default quick actions and delete all custom settings?',
      resetConfirmTitle: 'Reset continue writing presets',
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
      fixedActionHint: 'Built-in action',
      hideFixedAction: 'Hide from Cursor Chat',
      showFixedAction: 'Show in Cursor Chat',
    },
    chatPreferences: {
      title: 'Chat preferences',
      chatFontScale: 'Chat UI scale',
      chatFontScaleDesc:
        'Adjust the overall scale of the chat interface (default 100%).',
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
      noAssistants: 'No assistants available',
      noAssistant: 'Default',
      selectAssistant: 'Select assistant',
      duplicate: 'Duplicate',
      manageAll: 'Manage all…',
    },
    agent: {
      title: 'Agent',
      desc: 'Manage global tool availability. Enabled tools become selectable by agents; actual use must still be enabled in each agent.',
      globalCapabilities: 'Global capabilities',
      mcpServerCount: '{count} custom tool servers (MCP) connected',
      tools: 'Tools',
      toolsCount: '{count} tools',
      toolsCountWithEnabled: '{count} tools (enabled {enabled})',
      mcpLoadingStatus: 'Loading {count} MCP…',
      mcpErrorStatus: '{count} MCP failed to connect',
      skills: 'Skills',
      skillsCount: '{count} skills',
      skillsCountWithEnabled: '{count} skills (enabled {enabled})',
      skillsGlobalDesc:
        'Skills are discovered from built-in skills, {path}/*.md files, and {path}/<folder>/SKILL.md packages. Disable a skill here to block it for all agents.',
      yoloBaseDir: 'YOLO base folder',
      yoloBaseDirDesc:
        'Enter a vault-relative path (without a leading /). Example: use YOLO at vault root, or setting/YOLO under the setting folder.',
      yoloBaseDirPlaceholder: 'YOLO',
      yoloBaseDirHiddenPath:
        'YOLO root cannot use hidden folders. Remove the dot at the beginning of the folder name, for example change .yolo to yolo.',
      yoloBaseDirVoiceBusy:
        'Finish the current voice task before changing the YOLO root.',
      yoloBaseDirMigrated:
        'YOLO root now uses {target} so Obsidian can index it.',
      yoloBaseDirMigrationConflict:
        'YOLO root was not moved because {target} already exists. Your existing setting was kept.',
      yoloBaseDirMigrationFailed:
        'YOLO root could not be migrated. Your existing setting was kept.',
      yoloBaseDirMigrationRollbackFailed:
        'YOLO moved from {source} to {target}, but its setting could not be updated and the move could not be rolled back. Move the folder back to {source} manually before continuing.',
      yoloBaseDirMigrationManualRepair:
        'YOLO root {source} is hidden but cannot be migrated safely. Choose a visible YOLO root and move its YOLO files manually.',
      yoloBaseDirConflictTitle: 'YOLO root was not moved',
      yoloBaseDirConflictMessage:
        '{target} already exists and contains files. Nothing was moved to avoid overwriting or merging data. Choose an empty or nonexistent folder.',
      skillsSourcePath:
        'Source: built-in skills + {path}/*.md + {path}/<folder>/SKILL.md',
      refreshSkills: 'Refresh',
      skillsEmptyHint:
        'No skills found. Create a Markdown file or a folder containing SKILL.md under {path}.',
      createSkillTemplates: 'Initialize Skills system',
      skillsTemplateCreated: 'Skills system initialized in {path}.',
      importSkill: 'Import Skill',
      importSkillDesc:
        'Import skills into {path}. Markdown files keep their filenames; folders keep their names, SKILL.md, and all package resources.',
      importSkillDropzoneText: 'Drag & drop skill files or folders here',
      importSkillBrowseFiles: 'Browse Files',
      importSkillBrowseFolder: 'Browse Folder',
      importSkillFileCount: '{count} skill(s) selected ({files} files total)',
      importSkillFilesInPackage: 'file(s)',
      importSkillRemoveFile: 'Remove',
      importSkillConfirm: 'Import',
      importSkillSuccess: 'Successfully imported {count} skill(s).',
      importSkillInvalidFile: 'No valid skill files or packages found.',
      importSkillReadError: 'Failed to read files.',
      importSkillErrTooDeep:
        'Skill package exceeds the maximum import depth of {depth}. Nothing was imported.',
      importSkillWriteError: 'Failed to import {name}: {error}',
      importSkillErrHeader: '"{name}" cannot be imported:',
      importSkillErrNoSkillMd: 'missing SKILL.md file in folder',
      importSkillErrNoFrontmatter:
        'missing metadata header (---) at the top of the file',
      importSkillErrNoName: 'missing "name" field in metadata',
      importSkillConflictTitle: 'Skill already exists',
      importSkillConflictMessage:
        'A skill with the same name already exists. Do you want to overwrite it?',
      importSkillConflictOverwrite: 'Overwrite all',
      importSkillConflictMessageList:
        'The following skill(s) already exist: {names}\n\nClick "Overwrite all" to replace them, "Skip conflicts" to keep them, or close this dialog to cancel the import.',
      importSkillConflictSkip: 'Skip conflicts',
      importSkillUnsafePath: 'Refused unsafe path in "{name}": {path}',
      importSkillDuplicateInBatch:
        'Duplicate import destination in this batch: "{name}" (from "{source}"). Only the first occurrence is kept.',
      importSkillFromUrlPlaceholder: 'Paste a GitHub URL (repo / blob / tree)',
      importSkillFromUrlFetch: 'Fetch',
      importSkillFromUrlFetching: 'Fetching...',
      importSkillImporting: 'Importing...',
      importSkillFromUrlInvalid:
        'Please enter a valid GitHub URL (repo / blob / tree).',
      importSkillFromUrlNotFound:
        'Resource not found on GitHub. Check the URL and that the repository / file exists and is public.',
      importSkillFromUrlRateLimit:
        'GitHub API rate limit exceeded. Please try again later.',
      importSkillFromUrlTooLarge: 'Skill package exceeds size limit: {error}',
      importSkillFromUrlFetchError: 'Failed to fetch from GitHub: {error}',
      deleteSkillTitle: 'Delete skill',
      deleteSkillMessage:
        'Are you sure you want to delete the "{name}" skill package, including all resources? This cannot be undone.',
      deleteSkillConfirm: 'Delete',
      deleteSkillSuccess: '"{name}" has been deleted.',
      deleteSkillError: 'Failed to delete "{name}": {error}',
      deleteSkillNotFound: 'Skill not found',
      deleteSkillBatchMessage:
        'Are you sure you want to delete {count} skill(s), including package resources? This cannot be undone.',
      deleteSkillBatchSuccess: 'Deleted {count} skill(s).',
      deleteSkillBatchBtn: 'Delete',
      deleteSkillSelectAll: 'Select all',
      deleteSkillCancel: 'Cancel',
      selectSkills: 'Select',
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
      toolsGroupBuiltinVault: 'Vault',
      toolsGroupBuiltinContext: 'Context & Memory',
      toolsGroupBuiltinExternal: 'External',
      noMcpTools: 'No custom tools (MCP) discovered yet',
      toolsEnabledCount: '{count} enabled',
      manageTools: 'Manage tools',
      manageSkills: 'Manage skills',
      enableToolDisclosure: 'Enable on-demand tool loading (Beta)',
      enableToolDisclosureDesc:
        "Optional tools start as short descriptions, then load full details when needed. Recommended when you have many MCP tools enabled. Note: this mechanism relies on the model's own tool-use capability — some models may not reliably recognize tools loaded this way.",
      expandDescription: 'Expand',
      collapseDescription: 'Collapse',
      viewAllTools: 'View all tools',
      viewAllSkills: 'View all skills',
      enableAllTools: 'Enable all',
      disableAllTools: 'Disable all',
      descriptionColumn: 'Description',
      builtinFsListLabel: 'Read Vault',
      builtinFsListDesc: 'List vault directory structure',
      builtinFsSearchLabel: 'Search Vault',
      builtinFsSearchDesc: 'Search vault files and content',
      builtinFsReadLabel: 'Read',
      builtinFsReadDesc:
        'Read vault files, skills, or open web pages (browser://)',
      builtinContextPruneToolResultsLabel: 'Prune Tool Results',
      builtinContextPruneToolResultsDesc:
        'Exclude past tool results from future context. Note: this tool may break the prompt cache and increase request cost.',
      builtinContextCompactLabel: 'Compact Context',
      builtinContextCompactDesc: 'Compress earlier conversation into a summary',
      builtinToolSearchLabel: 'Load Tool',
      builtinToolSearchDesc: 'Load full schemas for on-demand tools',
      builtinFsEditLabel: 'Text Editing',
      builtinFsEditDesc: 'Edit text in a single file',
      builtinBashLabel: 'Virtual terminal',
      builtinBashDesc:
        'Search and inspect vault files, plus mkdir/mv/rm path operations',
      safetyControls: 'Safety Controls',
      safetyControlsDesc:
        'Configure extra review behavior before agents perform risky file operations.',
      fsEditReviewToggle: 'Require approval before editing files',
      fsEditReviewToggleDesc:
        'When enabled, agent fs_edit changes open inline/apply review before writing the file.',
      builtinFsEditOpsLabel: 'File Editing Toolset',
      builtinFsEditOpsDesc: 'Edit targeted text or write full file content',
      builtinMemoryOpsLabel: 'Memory Toolset',
      builtinMemoryOpsDesc: 'Add, update, and delete memory',
      builtinMemoryAddLabel: 'Add Memory',
      builtinMemoryAddDesc:
        'Add one memory item into global or assistant memory and auto-assign an id.',
      builtinMemoryUpdateLabel: 'Update Memory',
      builtinMemoryUpdateDesc: 'Update an existing memory item by id.',
      builtinMemoryDeleteLabel: 'Delete Memory',
      builtinMemoryDeleteDesc: 'Delete an existing memory item by id.',
      builtinOpenSkillLabel: 'Open Skill',
      builtinOpenSkillDesc: 'Load a skill markdown',
      builtinWebSearchLabel: 'Web Search',
      builtinWebSearchDesc:
        'Search the web through a configured search provider and return ranked results with snippets.',
      builtinWebScrapeLabel: 'Web Scrape',
      builtinWebScrapeDesc:
        'Fetch the full content of a single URL through a configured search provider.',
      builtinWebOpsLabel: 'Web Search Toolset',
      builtinWebOpsDesc: 'Web search and page scraping',
      builtinJsEvalLabel: 'Analysis Sandbox',
      builtinJsEvalDesc:
        'Run JavaScript in an isolated sandbox for precise computation, batch statistics, and data processing; grant retrieval, vault read-only, and network capabilities individually.',
      builtinTerminalCommandLabel: 'Terminal Commands',
      builtinTerminalCommandDesc:
        'Run commands in the local terminal, desktop-only',
      builtinDelegateSubagentLabel: 'Delegate Subagent',
      builtinDelegateSubagentDesc:
        'Dispatch an isolated temporary subagent to complete a self-contained task asynchronously.',
      builtinTodoWriteLabel: 'Task List',
      builtinTodoWriteDesc:
        'Let the agent plan and track multi-step task progress autonomously. Agent mode only.',
      builtinAskUserQuestionLabel: 'Ask User',
      builtinAskUserQuestionDesc:
        'Ask the user a question when required information is missing, then resume after the answer.',
      editorDefaultName: 'New agent',
      editorIntro: "Configure this agent's capabilities, model, and behavior.",
      editorTabProfile: 'Profile',
      editorTabTools: 'Tools',
      editorTabSkills: 'Skills',
      editorTabWorkspace: 'Workspace',
      workspace: {
        enableTitle: 'Restrict directory access',
        enableDesc:
          'When off, this agent can access the entire vault. When on, only the rules below apply.',
        includeTitle: 'Allow',
        includeDesc: 'Only read/write files under these paths',
        includeBadge: 'INCLUDE',
        includeEmpty:
          'Leave empty to allow everything except the exclude list below.',
        excludeTitle: 'Deny',
        excludeDesc: 'Excluded from the allow range (higher priority)',
        excludeBadge: 'EXCLUDE',
        excludeEmpty: 'No exclusions.',
      },
      editorTabModel: 'Model',
      editorName: 'Name',
      editorNameDesc: 'Agent display name',
      editorDescription: 'Description',
      editorDescriptionDesc: 'Short summary for this agent',
      editorIcon: 'Icon',
      editorIconDesc: 'Pick an icon for this agent',
      editorChooseIcon: 'Choose icon',
      editorSystemPrompt: 'System prompt',
      editorSystemPromptDesc: 'Primary behavior instruction for this agent.',
      editorSystemPromptExpand: 'Expand editor',
      editorSystemPromptCollapse: 'Close expanded editor',
      editorEnableProjectInstructions: 'Load project instruction files',
      editorEnableProjectInstructionsDesc:
        'Auto-load AGENTS.md and CLAUDE.md from the vault root for this agent. Compatible with Codex / Claude Code / Cursor and similar tools.',
      editorEnableTools: 'Enable tools',
      editorEnableToolsDesc: 'Allow this agent to call tools',
      editorIncludeBuiltinTools: 'Include built-in tools',
      editorIncludeBuiltinToolsDesc:
        'Allow local vault file tools for this agent',
      toolApproval: 'Approval',
      toolApprovalFullAccess: 'Full access',
      toolApprovalRequire: 'Require approval',
      toolApprovalDangerousOnly: 'Approve dangerous operations',
      toolDisclosureAuto: 'Auto',
      toolDisclosureAutoSelect: 'Auto select',
      toolDisclosureAlways: 'In context',
      toolDisclosureMixed: 'Mixed',
      toolDisclosureOnDemand: 'On demand',
      editorEnabled: 'Enabled',
      editorDisabled: 'Disabled',
      editorModel: 'Model',
      editorModelDesc: 'Select the model used by this agent',
      followDefaultModel: 'Follow default model',
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
      agentCapabilitiesBlockTitle: 'Agent capabilities',
      focusSyncTitle: 'Focus sync',
      focusSyncDesc:
        'When enabled, the AI can sense where you are in the note, PDF, or web page you are viewing. Full web page content is read via fs_read with a browser:// path.',
      timeContextTitle: 'Current time awareness',
      timeContextDesc:
        'Lets the model know the current time when each message is sent.',
      imageReadingBlockTitle: 'Image reading',
      imageReadingEnabled: 'Image reading',
      imageReadingEnabledDesc:
        'Automatically extract embedded images when reading Markdown files, sending them to the model as multimodal content.',
      externalImageFetchEnabled: 'Fetch external image URLs',
      externalImageFetchEnabledDesc:
        'Also fetch http(s) image URLs referenced in Markdown (image hosts, CDNs). Disabled by default — enabling it will send outbound requests to third-party hosts. Fetches time out after 5s and skip images larger than 10MB.',
      imageCompressionEnabled: 'Image compression',
      imageCompressionEnabledDesc:
        'Compress extracted images to reduce token usage and transfer size.',
      imageCompressionQuality: 'Compression quality',
      imageCompressionQualityDesc:
        'Image compression ratio (1-100). Controls both dimensions and quality, e.g. 60 scales to 60% size at 60% quality.',
      cliRuntimesBlockTitle: 'CLI runtimes',
      claudeCliPathName: 'Claude Code CLI path',
      claudeCliPathDesc:
        'Custom path to the claude executable — paste the output of "which claude". Leave empty to auto-detect. Stored on this device only.',
      codexCliPathName: 'Codex CLI path',
      codexCliPathDesc:
        'Custom path to the codex executable — paste the output of "which codex" ("where codex" on Windows). Leave empty to auto-detect. Stored on this device only.',
      cliPathMissing:
        'This path does not exist on this device; auto-detection will be used instead.',
      autoContextCompactionBlockTitle: 'Context compaction',
      autoContextCompaction: 'Automatic context compaction',
      autoContextCompactionDesc:
        'When the context reaches the threshold, remind the Agent to run the context compaction command.',
      autoContextCompactionThresholdMode: 'Compaction threshold mode',
      autoContextCompactionModeTokens: 'Absolute prompt tokens',
      autoContextCompactionModeRatio: 'Fraction of context window',
      autoContextCompactionThresholdTokens: 'Prompt token threshold',
      autoContextCompactionThresholdTokensDesc:
        "Trigger when the last reply's reported prompt_tokens is at least this value.",
      autoContextCompactionThresholdRatioPercent: 'Context window usage (%)',
      autoContextCompactionThresholdRatioPercentDesc:
        "Trigger when prompt_tokens divided by the chat model's max context window reaches this percentage. Requires max context tokens on the model.",
      mcpServerBlockTitle: 'External agent access',
      mcpServerEnabled: 'Allow external agent access',
      mcpServerDesc:
        'Allow external agents to search the Vault through MCP and delegate tasks to configured YOLO agents.',
      mcpServerDesktopOnly: 'The MCP service is available on desktop only.',
      mcpServerClientConfig: 'MCP connection configuration',
      mcpServerCopyConfig: 'Copy',
      mcpServerError: 'Failed to start',
      mcpServerConfigCopied: 'MCP configuration copied.',
      mcpServerCopyFailed: 'Failed to copy MCP configuration.',
      jsSandboxExtTitle: 'Extension capabilities',
      jsSandboxAllowFetch: 'Allow Network Fetch',
      jsSandboxAllowFetchDesc:
        'Allow browser network requests, plus a separate $fetch helper for requests that need YOLO to bypass cross-origin limits. Also enabled automatically when external scripts are enabled.',
      jsSandboxAllowFetchRisk:
        'Risk: scripts can reach any URL the browser can — public APIs, your local network, internal services, and the LLM provider itself. Data in the script (including vault contents you pass in) can be exfiltrated. Only enable for agents you fully trust.',
      jsSandboxAllowFetchConfirm:
        'Enabling network requests lets scripts contact browser-accessible addresses and use a separate YOLO host request helper when browser cross-origin limits block a response. Only enable this for an agent you trust. Continue?',
      jsSandboxAllowVaultRead: 'Allow Vault Read',
      jsSandboxAllowVaultReadDesc:
        'Let scripts list vault paths and read any vault file by path. This capability is not constrained by the agent directory scope. Risk: scripts could pass note contents to external services.',
      jsSandboxAllowVaultReadConfirm:
        "Enabling vault read lets AI-generated scripts list vault paths and read any file in the vault by path. This data passes through the LLM context. Only enable if you trust this agent's scripts. Continue?",
      jsSandboxAllowBrowserRead: 'Allow Open Web Page Read',
      jsSandboxAllowBrowserReadDesc:
        'Let scripts read the full HTML of web pages already open in Obsidian by page ID. This can include logged-in or private page content.',
      jsSandboxAllowBrowserReadRisk:
        'Risk: scripts can read the full page DOM from pages you have opened in Obsidian, including hidden fields, embedded state, and private or logged-in content. Only enable for agents you fully trust.',
      jsSandboxAllowBrowserReadConfirm:
        'Enabling open web page read lets AI-generated scripts read full HTML from web pages already open in Obsidian by page ID. This content passes through the LLM context. Continue?',
      jsSandboxBrowserReadMaxKb: 'Max page HTML size (KB)',
      jsSandboxBrowserReadMaxKbDesc:
        'Per-call full HTML limit. Larger pages are refused instead of shortened. Range 1–1048576 KB. Leave blank to use the default.',
      jsSandboxAllowDbQuery: 'Allow Knowledge Base Query',
      jsSandboxAllowDbQueryDesc:
        'Let scripts query indexed vault content with semantic search and read Markdown/text content by known path. This capability is not constrained by the agent directory scope.',
      jsSandboxAllowDbQueryConfirm:
        'Enabling knowledge base query lets AI-generated scripts search indexed content and read Markdown/text content by known path. Continue?',
      jsSandboxAllowExternalScripts: 'Allow External Scripts',
      jsSandboxAllowExternalScriptsDesc:
        'Allow scripts to load and run remote JavaScript, and open the broader browser capabilities needed by those scripts.',
      jsSandboxAllowExternalScriptsRisk:
        'EXTREME RISK: the agent can pull in and execute arbitrary remote JavaScript with the same privileges as your browser tab. This is functionally equivalent to running untrusted code from the internet. Anything in the vault that you pass into a script can be exfiltrated. Only enable for agents and code sources you fully trust.',
      jsSandboxAllowExternalScriptsConfirm:
        'Enabling external scripts lets the agent load and run remote JavaScript inside Obsidian. This is powerful and risky: only continue if you fully trust this agent and the code source.',
      jsSandboxConfirmEnableTitle: 'Enable extension capability',
      jsSandboxTimeoutMs: 'Execution timeout (ms)',
      jsSandboxTimeoutMsDesc:
        'Maximum runtime for a single script call. Range {min}–{max}.',
      jsSandboxOutputMaxKb: 'Max tool result size (KB)',
      jsSandboxOutputMaxKbDesc:
        'Upper bound on the JSON result returned to the model. Larger output is truncated to a prefix. Oversized responses consume model context tokens and can exceed the context window, driving up cost. Range {min}–{max} KB.',
      jsSandboxVaultReadMaxKb: 'Max read size (KB)',
      jsSandboxVaultReadMaxKbDesc:
        'Per-call read limit. Larger text is shortened with a notice; larger binary files are refused. Range {min}–{max} KB.',
      jsSandboxDbMaxLimit: 'Max semantic rows',
      jsSandboxDbMaxLimitDesc:
        'Upper bound on semantic search results. Path reads are not affected. Range 1–100.',
    },
    jsSandbox: {
      openSettings: 'Configure analysis sandbox',
    },
    terminalCommand: {
      openSettings: 'Configure terminal command',
      blockedPrefixes: 'Blocked command prefixes',
      blockedPrefixesDesc:
        'Commands matching these prefixes will be rejected before execution.',
      matchingRule:
        'Prefix matching uses the first command token: rm blocks rm -rf /, but not npm run build.',
      addPrefixPlaceholder: 'Command prefix, e.g. rm',
      resetDefaults: 'Reset to defaults',
    },
    subagent: {
      openSettings: 'Configure subagent models',
      modelPool: 'Subagent model pool',
      modelPoolDesc:
        'The parent agent can dispatch subagents only with models in this pool.',
      preferredModelRule:
        'If the parent agent does not pass modelId explicitly, the preferred model is used.',
      addModelsTitle: 'Add subagent models',
      addModelsDesc:
        'Select registered chat models to add to the subagent model pool.',
      addModelPlaceholder: 'Select a model',
      addModel: 'Add model',
      addSelectedModels: 'Add selected models',
      searchModels: 'Search models...',
      setPreferredModel: 'Set as preferred model',
      defaultModel: 'Default',
      setDefaultModel: 'Set default',
      emptyModelPool: 'No subagent models selected.',
      poolCount: '{count} models',
    },
    webSearch: {
      modalTitle: 'Web search settings',
      openSettings: 'Configure web search providers',
      intro:
        'Configure search providers used by the built-in web_search agent tool. The default provider below is used when the agent invokes web_search.',
      providersHeader: 'Providers',
      addProvider: 'Add provider',
      editProvider: 'Edit provider',
      empty:
        'No providers configured yet. Add one to enable the web_search tool.',
      colName: 'Name',
      colType: 'Type',
      colDefault: 'Default',
      colActions: 'Actions',
      deleteFailed: 'Failed to delete provider.',
      commonHeader: 'Common',
      resultSize: 'Result size',
      resultSizeDesc:
        'Maximum number of results returned to the model per search.',
      searchTimeout: 'Search timeout (ms)',
      scrapeTimeout: 'Scrape timeout (ms)',
      searchTimeoutLabel: 'Search timeout',
      searchTimeoutDesc: 'Maximum wait time for a provider search call.',
      scrapeTimeoutLabel: 'Scrape timeout',
      scrapeTimeoutDesc: 'Maximum wait time for a single web_scrape call.',
      unitResults: 'items',
      tagDefault: 'Default',
      failoverNotice:
        'Failed calls are not silently retried against another provider — the error is surfaced to the model so the agent can decide to retry or change approach.',
      providerCount: 'Total providers',
      types: {
        tavily: 'Tavily',
        jina: 'Jina',
        searxng: 'SearXNG',
        bing: 'Bing (no key)',
        'gemini-grounding': 'Gemini (Grounding)',
        grok: 'Grok',
        zhipu: 'Zhipu Web Search',
        exa: 'Exa',
      },
      fieldName: 'Display name',
      fieldApiKey: 'API key',
      fieldDepth: 'Depth',
      fieldSearchUrl: 'Search URL',
      fieldScrapeUrl: 'Scrape URL',
      fieldUseProviderScrapeApi: 'Use provider scrape API',
      fieldUseProviderScrapeApiDesc:
        'When enabled, web_scrape uses this provider\u2019s extract API. When disabled, web_scrape uses the built-in generic scraper (static HTML, no extra API usage).',
      fieldBaseUrl: 'Base URL',
      fieldLanguage: 'Language',
      fieldEngines: 'Engines (comma-separated)',
      fieldUsername: 'Basic auth username',
      fieldPassword: 'Basic auth password',
      fieldModel: 'Model',
      fieldSystemPrompt: 'System prompt',
      fieldEnableX: 'Also search X',
      fieldZhipuEngine: 'Search engine',
      fieldZhipuContentSize: 'Content size',
      fieldZhipuRecency: 'Recency filter',
      fieldZhipuDomainFilter: 'Domain filter (optional)',
      bingNote:
        'Bing requires no API key. The provider scrapes the public results page; reliability depends on Bing\u2019s anti-bot measures.',
    },
    providers: {
      title: 'Providers',
      desc: 'Enter your API keys for the providers you want to use',
      howToGetApiKeys: 'How to obtain API keys',
      addProvider: 'Add provider',
      pickerTitle: 'Add provider',
      pickerSearchPlaceholder: 'Search providers · press Enter',
      pickerCustomLabel: 'Custom provider',
      pickerCustomDesc: 'Base URL + API key',
      pickerEmpty: 'No matching providers',
      categoryAll: 'All',
      categoryMain: 'International',
      categoryCn: 'China',
      categoryGateway: 'Gateway',
      categoryCloud: 'Cloud',
      categoryLocal: 'Local',
      badgeOpenAiCompatible: 'OpenAI compatible',
      badgeNative: 'Native protocol',
      badgeOAuth: 'OAuth',
      badgeAdded: 'Added',
      kind: {
        openai: 'Reasoning · Multimodal',
        chatgptOAuth: 'ChatGPT Plus / Pro',
        anthropic: 'Chat · Reasoning',
        gemini: 'Multimodal',
        geminiOAuth: 'Google account',
        mistral: 'Chat · Embedding',
        perplexity: 'Search-augmented chat',
        groq: 'Fast inference',
        morph: 'Edit model',
        deepseek: 'Chat · Reasoning',
        moonshot: 'Long context',
        openrouter: 'Router',
        azure: 'Enterprise cloud',
        bedrock: 'Enterprise cloud',
        ollama: 'Local',
        lmStudio: 'Local',
      },
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
      apiUrlPreviewLabel: 'Preview:',
      noStainlessHeaders: 'No stainless headers',
      noStainlessHeadersDesc:
        'Enable this if you encounter cross-origin errors related to stainless headers.',
      useObsidianRequestUrl: 'Use Obsidian requestUrl',
      useObsidianRequestUrlDesc:
        'Use Obsidian requestUrl to bypass cross-origin restrictions. Streaming responses are buffered.',
      requestTransportMode: 'Network request method',
      requestTransportModeDesc:
        'Choose how this provider sends network requests on this device. Desktop direct connection is recommended on desktop. On mobile, switch to Obsidian built-in request if browser requests have streaming or network issues.',
      requestTransportModeAuto: 'Auto (recommended)',
      requestTransportModeBrowser: 'Browser request',
      requestTransportModeObsidian: 'Obsidian built-in request',
      requestTransportModeNode: 'Desktop direct connection (recommended)',
      responseStreamingMode: 'Response streaming mode',
      responseStreamingModeDesc:
        'Control whether this provider uses streaming or non-streaming responses.',
      responseStreamingModeAuto: 'Auto (default)',
      responseStreamingModeStreaming: 'Streaming',
      responseStreamingModeNonStreaming: 'Non-streaming',
      promptCaching: 'Prompt caching',
      promptCachingDesc:
        'Enable Anthropic ephemeral prompt caching. Reuses system prompt, tools, and conversation history across turns to cut input tokens. Cache writes carry a 25% premium; reads cost ~10% of normal input. Available whenever the provider API type is Anthropic; upstream must actually honor the cache_control field.',
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
      chatgptOAuthBrowserLogin: 'Browser login',
      chatgptOAuthDeviceLogin: 'Device code login',
      chatgptOAuthBrowserConnecting: 'Opening browser...',
      chatgptOAuthDeviceConnecting: 'Waiting for authorization...',
      chatgptOAuthBrowserDesktopOnly:
        'Browser login is only available on desktop.',
      chatgptOAuthBrowserOpened:
        'ChatGPT login opened in your browser. Complete authorization there.',
      chatgptOAuthDeviceOpened:
        'Enter the device code below on the ChatGPT authorization page.',
      chatgptOAuthConnectedNotice: 'ChatGPT OAuth connected.',
      chatgptOAuthDisconnectedNotice: 'ChatGPT OAuth disconnected.',
      chatgptOAuthPortFallback:
        'Use device code login instead; it does not require a local port.',
      chatgptOAuthPendingCode: 'Device code',
      chatgptOAuthDeviceHelp:
        'Enter this code on the authorization page within 15 minutes. Continue only if you started this login.',
      chatgptOAuthCopyCode: 'Copy code',
      chatgptOAuthCodeCopied: 'Device code copied.',
      chatgptOAuthOpenDevicePage: 'Open authorization page',
      chatgptOAuthCancelDevice: 'Cancel',
      oauthDesktopOnly:
        'OAuth login is only available on desktop. Please connect on desktop first.',
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
      connectivityTest: {
        button: 'Connectivity Test',
        title: 'Connectivity Test',
        testAll: 'Test All',
        retest: 'Retest',
        stop: 'Stop',
        test: 'Test',
        passed: 'Passed',
        statusTesting: 'Testing',
        statusOk: 'OK',
        statusFail: 'Failed',
        statusTimeout: 'Timeout',
        statusIdle: 'Pending',
        normalCount: 'OK',
        abnormalCount: 'failing',
        notTested: 'Not tested yet',
        noResponse: 'No response',
        firstToken: 'First token',
        dims: 'dims',
        noModels: 'No models configured under this provider',
        deleteModel: 'Delete model',
        deleteChatModelBlocked:
          'Cannot delete the model currently selected as chat or title model',
        deleteEmbeddingModelBlocked:
          'Cannot delete the currently selected embedding model',
        deleteEmbeddingModelInProgress: 'Deleting embedding model…',
      },
      availableModelsAuto: 'Available models (auto-fetched)',
      searchModels: 'Search models...',
      modeSingle: 'Single',
      modeBatch: 'Batch',
      batchSelectAll: 'Select all',
      batchSelected: 'Selected',
      batchAlreadyAdded: 'Added',
      batchAdd: 'Add selected',
      batchHint:
        'Batch-added models use default settings; fine-tune each one afterwards.',
      fetchModelsFailed: 'Failed to fetch models',
      embeddingModelsFirst: 'Embedding models are listed first',
      reasoningType: 'Model type',
      reasoningTypeDesc: 'When unsure, OpenAI reasoning is the safer pick.',
      reasoningTypeNone: 'Non-reasoning model / default',
      reasoningTypeOpenAI: 'OpenAI reasoning_effort style',
      reasoningTypeGemini: 'Gemini thinking_budget style',
      reasoningTypeAnthropic: 'Anthropic extended thinking (adaptive + effort)',
      reasoningTypeGeneric: 'Generic reasoning model',
      inputModality: 'Input modality',
      inputModalityDesc:
        'Input types this model actually supports. A wrong pick will cause request failures.',
      inputModalityText: 'Text',
      inputModalityVision: 'Vision',
      inputModalityVisionTooltip:
        'Requires a model with native vision capability.',
      inputModalityPdf: 'PDF (native)',
      inputModalityPdfTooltip:
        'Requires a model that supports native PDF input (Gemini / Anthropic).',
      openaiReasoningEffort: 'Reasoning effort',
      openaiReasoningEffortDesc:
        'Choose effort: minimal (gpt-5 only) / low / medium / high',
      geminiThinkingBudget: 'Thinking budget (thinking budget)',
      geminiThinkingBudgetDesc:
        'Units are thinking tokens. 0 = off; -1 = dynamic (gemini only); ranges vary by model.',
      geminiThinkingBudgetPlaceholder: 'For example, -1 (dynamic, 0=off)',
      builtinToolProvider: 'Built-in provider tools',
      builtinToolProviderDesc:
        'Native tools provided by the model provider. Independent of YOLO built-in tools. Whether they actually take effect depends on the gateway the request runs through.',
      builtinToolProviderNone: 'Disabled',
      builtinToolProviderGemini: 'Gemini',
      builtinToolProviderGpt: 'OpenAI',
      builtinToolProviderOpenRouter: 'OpenRouter',
      builtinToolProviderGrok: 'Grok',
      builtinToolProviderDeepSeek: 'DeepSeek',
      builtinToolsGpt: 'OpenAI built-in tools',
      builtinToolsOpenRouter: 'OpenRouter built-in tools',
      builtinToolsGrok: 'Grok built-in tools',
      builtinToolsGemini: 'Gemini built-in tools',
      builtinToolsDeepSeek: 'DeepSeek built-in tools',
      builtinToolWebSearch: 'Web Search',
      builtinToolWebSearchDesc:
        'Allow the model to search the web and return cited sources.',
      builtinToolDeepSeekWebSearchDesc:
        'Web search runs on DeepSeek servers — no separate search provider needed. Once enabled, YOLO’s own web search is no longer offered to this model, so it stops trying both; web scraping stays available.',
      builtinToolDeepSeekWebSearchUnavailable:
        'This provider’s current API type does not support the official web search. Switch its API type to Anthropic or OpenAI Responses first.',
      builtinToolUrlContext: 'URL Context',
      builtinToolUrlContextDesc:
        'Allow the model to fetch links mentioned in the conversation as context.',
      openRouterWebSearchEngine: 'Search engine',
      openRouterWebSearchEngineDesc:
        "Auto lets OpenRouter pick (default). Native uses the model provider's built-in search. Exa / Firecrawl / Parallel force the corresponding engine. Firecrawl requires your own API key configured in the OpenRouter dashboard.",
      openRouterWebSearchEngineAuto: 'Auto (default)',
      openRouterWebSearchEngineNative: 'Native',
      openRouterWebSearchEngineExa: 'Exa',
      openRouterWebSearchEngineFirecrawl: 'Firecrawl (BYOK)',
      openRouterWebSearchEngineParallel: 'Parallel',
      openRouterWebSearchMaxResults: 'Max results',
      openRouterWebSearchMaxResultsDesc:
        'Optional, 1–25. Leave empty to use the OpenRouter default.',
      openRouterWebSearchMaxResultsPlaceholder: 'default',
      sampling: 'Custom parameters',
      restoreDefaults: 'Restore defaults',
      maxContextTokens: 'Context window tokens',
      maxContextTokensDesc:
        'Auto-filled when this model is recognized. Adjust it if your provider uses a different limit.',
      maxOutputTokens: 'Max output tokens',
      requestParameters: 'Request parameters',
      requestParametersDesc:
        'Usually no adjustment is needed. Fields left disabled use the provider defaults.',
      requestParametersEnabledCount: '{count} request parameters enabled',
      clearRequestParameterOverrides: 'Clear overrides',
      additionalParameters: 'Other parameters',
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
      desc: 'Manage knowledge base indexing. RAG is invoked automatically when the Agent uses the Search tool in Hybrid or RAG mode.',
      enableRag: 'Enable knowledge base indexing',
      enableRagDesc: 'Build indexes for documents within the selected scope.',
      partialFailureSummary: 'Done · {{count}} file(s) could not be indexed',
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
      embeddingConcurrency: 'Embedding concurrency',
      embeddingConcurrencyDesc:
        'Maximum parallel embedding requests during indexing (1–24, default 10). Lower this if the embedding provider returns 429 / rate-limit errors (e.g. Azure S0 tier or per-minute-quota free tiers).',
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
      rebuildFromScratch: 'Rebuild from scratch',
      rebuildFromScratchConfirm:
        'This will clear all existing vectors for the current embedding model and re-index the entire vault, which may incur many embedding API calls. Continue?',
      continueIndex: 'Continue indexing',
      continueIndexNow: 'Continue now',
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
        'When enabled, incrementally update the index in the background after documents change.',
      indexPdf: 'Index PDF files',
      indexPdfDesc:
        'Extract and index PDF text for the knowledge base. The first full rebuild may take longer; turn off for very large vaults if you do not need PDF retrieval.',
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
        'Once enabled, the knowledge base maintains its index in the background according to the auto-update setting.',
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
      retryNow: 'Retry now',
      waitingRetry: 'Waiting to retry...',
      cancelIndex: 'Cancel',
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
      modeForm: 'Form',
      modeJson: 'JSON',
      editorMode: 'Configuration editor',
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
      transportField: 'Connection type',
      transportFieldDesc: 'Choose how YOLO connects to this server.',
      remoteTransports: 'Remote',
      localTransports: 'Local',
      transportHttp: 'Streamable HTTP',
      transportSse: 'SSE',
      transportWs: 'WebSocket',
      transportStdio: 'stdio',
      urlField: 'Server URL',
      urlFieldDesc: 'The URL provided by the MCP server.',
      authenticationField: 'Authentication',
      authenticationFieldDesc: 'Choose how this server verifies your identity.',
      authenticationOAuth: 'OAuth',
      authenticationNone: 'No authentication',
      authenticationHeaders: 'Custom headers',
      oauthTitle: 'Connect with OAuth',
      oauthDesc:
        'YOLO will open your browser so you can authorize this MCP server securely.',
      oauthNotConnected: 'Not connected',
      oauthConnect: 'Connect',
      oauthCancelConnection: 'Stop connecting',
      oauthReconnect: 'Reconnect',
      oauthChecking: 'Checking...',
      oauthConnecting: 'Connecting...',
      oauthConnected: 'Connected',
      oauthConnectionFailed: 'Connection failed',
      oauthConnectBeforeSave: 'Connect with OAuth before saving this server.',
      oauthHttpRequired: 'OAuth requires an HTTP or HTTPS server URL.',
      commandField: 'Command',
      commandFieldDesc: 'The executable used to start the MCP server.',
      argumentsField: 'Arguments',
      argumentsFieldDesc: 'Enter one command argument per line.',
      cwdField: 'Working directory',
      cwdFieldDesc: 'Optional directory in which to start the command.',
      headersField: 'Headers',
      headersFieldDesc:
        'Optional headers for servers that use manual authentication.',
      addHeader: 'Add header',
      headerKeyPlaceholder: 'Header name',
      headerValuePlaceholder: 'Header value',
      environmentField: 'Environment variables',
      environmentFieldDesc: 'Values passed to the local server process.',
      addEnvironmentVariable: 'Add variable',
      environmentKeyPlaceholder: 'Variable name',
      environmentValuePlaceholder: 'Value',
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
    editor: {
      snippets: {
        sectionTitle: 'Snippets',
        sectionDesc:
          'Type / in the chat input and pick a snippet to insert a preset prompt. Snippets live in {{path}}.',
        cardName: 'Snippet library',
        cardDescCount: '{count} snippets',
        cardDescMissing: 'No snippets.md file yet',
        manageBtn: 'Manage snippets',
        initBtn: 'Initialize snippets',
        modalTitle: 'Manage snippets',
        modalCallout:
          'Snippets live in {{path}}. Trigger the chat input with / and pick one to insert its body.',
        openFileBtn: 'Open snippets.md',
        createFileBtn: 'Create snippets.md',
        empty: 'No snippets yet',
        jumpBtn: 'Edit',
        deleteBtn: 'Delete',
        deleteTitle: 'Delete snippet',
        deleteMessage:
          'Are you sure you want to delete snippet "{trigger}"? This cannot be undone.',
        deleteConfirm: 'Delete',
        deleteSuccess: 'Deleted snippet "{trigger}"',
        deleteError: 'Delete failed: {error}',
        openError: 'Failed to open snippets.md: {error}',
      },
    },
    continuation: {
      title: 'Sparkle',
      aiSubsectionTitle: 'Super continuation',
      tabSubsectionTitle: 'Tab completion',
      superContinuation: 'Enable Sparkle view',
      superContinuationDesc:
        'Enable the Sparkle sidebar view where you can configure dedicated continuation models, parameters, rules, and reference sources; when disabled, only the chat view is available.',
      continuationModel: 'Continuation model',
      continuationModelDesc:
        'Select the model used for continuation in Sparkle.',
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
      tabCompletionMultipleCandidates: 'Generate multiple candidates',
      tabCompletionMultipleCandidatesDesc:
        'Generate three completion suggestions when enabled.',
      tabCompletionModel: 'Completion model',
      tabCompletionModelDesc:
        'Choose the model used for tab completion and length adjustment.',
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
      tabCompletionRequestTimeout: 'Request timeout (seconds)',
      tabCompletionRequestTimeoutDesc:
        'Abort a tab completion request if it takes longer than this many seconds. Raise it for slower or long-reasoning models.',
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
      tabCompletionTriggerAcceptMode: 'Accept behavior',
      tabCompletionTriggerAcceptModeInsert: 'Insert at cursor',
      tabCompletionTriggerAcceptModeReplace: 'Replace matched text',
      tabCompletionTriggerDescription: 'Description',
      tabCompletionTriggerRemove: 'Remove',
    },
    etc: {
      title: 'Other',
      pluginAutoUpdate: 'Auto-download updates',
      pluginAutoUpdateDesc:
        'When enabled, new versions are downloaded automatically in the background when detected.',
      pluginAutoUpdateDescUnavailable:
        'Module updates are downloaded automatically; one-click Core installation still requires desktop and a writable plugin folder.',
      exportConfig: 'Export settings',
      exportConfigDesc:
        'Export current plugin settings to a JSON file for use in other vaults.',
      export: 'Export',
      importConfig: 'Import settings',
      importConfigDesc:
        'Import plugin settings from an export file or another vault.',
      import: 'Import',
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
      captureRawRequestDebug: 'Enable LLM request debugging',
      captureRawRequestDebugDesc:
        'When enabled, each AI response shows a Debug button (in the info bar and the more-actions menu) that lets you view or export the raw LLM, tool-call, and web-search requests and responses for that turn. Captured data is kept in memory for the current Obsidian session only and is cleared on restart. API keys are redacted in the export, but the original conversation content is included.',
      captureRawRequestDebugExcludeLogsTitle:
        'Exclude debug logs from knowledge base?',
      captureRawRequestDebugExcludeLogsMessage:
        'Debug logs may contain raw conversation and tool contents. Add {{path}} to the knowledge base exclude list so they are not indexed by RAG?',
      captureRawRequestDebugExcludeLogsCta: 'Exclude logs',
      captureRawRequestDebugExcludeLogsSuccess:
        '{{path}} has been excluded from the knowledge base.',
      yoloBaseDir: 'YOLO base folder',
      yoloBaseDirDesc:
        'Enter a vault-relative path (without a leading /). Example: use YOLO at vault root, or setting/YOLO under the setting folder. Current skills directory: {path}.',
      yoloBaseDirPlaceholder: 'YOLO',
      yoloBaseDirHiddenPath:
        'YOLO root cannot use hidden folders. Remove the dot at the beginning of the folder name, for example change .yolo to yolo.',
      yoloBaseDirInvalidPath:
        'YOLO root contains a folder name that is not supported across devices. Avoid control characters, Windows reserved names, and the characters <>:"\\|?*.',
      yoloBaseDirMigrated:
        'YOLO root now uses {target} so Obsidian can index it.',
      yoloBaseDirMigrationConflict:
        'YOLO root was not moved because {target} already exists. Your existing setting was kept.',
      yoloBaseDirMigrationFailed:
        'YOLO root could not be migrated. Your existing setting was kept.',
      yoloBaseDirMigrationRollbackFailed:
        'YOLO moved from {source} to {target}, but its setting could not be updated and the move could not be rolled back. Move the folder back to {source} manually before continuing.',
      yoloBaseDirMigrationManualRepair:
        'YOLO root {source} is hidden but cannot be migrated safely. Choose a visible YOLO root and move its YOLO files manually.',
      yoloBaseDirConflictTitle: 'YOLO root was not moved',
      yoloBaseDirConflictMessage:
        '{target} already exists and contains files. Nothing was moved to avoid overwriting or merging data. Choose an empty or nonexistent folder.',
      ribbonClickAction: 'Ribbon icon opens chat in',
      ribbonClickActionDesc:
        'Where the YOLO ribbon icon opens the Chat view. If a chat already exists in the chosen location it is activated; otherwise a new one is created.',
      ribbonClickActionSidebar: 'Right sidebar',
      ribbonClickActionTab: 'New tab',
      ribbonClickActionSplit: 'Right split',
      ribbonClickActionWindow: 'New window',
      ribbonClickActionLast: 'Last used location',
      enterKeyCreatesNewline: 'Use Enter to start a new line',
      enterKeyCreatesNewlineDesc:
        'Applies to Chat and Quick Ask inputs. Press Cmd/Ctrl + Enter to send.',
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
      chatExportSubsectionTitle: 'Chat export',
      chatExportIncludeThinking: 'Export thinking process',
      chatExportIncludeThinkingDesc:
        'Include assistant reasoning blocks in exported chat markdown.',
      chatExportIncludeToolCalls: 'Export tool calls',
      chatExportIncludeToolCallsDesc:
        'Include tool call arguments and results in exported chat markdown.',
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
    },

    asr: {
      title: 'Voice recognition (ASR)',
      descriptionV2:
        'Each row is one ASR endpoint. Badges show which features have selected it; choose them under Voice → Context-aware voice input and Voice → Audio file transcription.',
      descriptionV3:
        'Voice recognition endpoints are grouped by short HTTP, long HTTP, and WebSocket routes. Choose active endpoints under Voice → Context-aware voice input and Voice → Audio file transcription.',
      sectionTitle: {
        'http-short-audio': 'HTTP short audio',
        'http-long-audio': 'HTTP long audio',
        websocket: 'WebSocket',
      },
      sectionEmpty: {
        'http-short-audio': 'No short-audio HTTP provider configured.',
        'http-long-audio': 'No long-audio HTTP provider configured.',
        websocket: 'No WebSocket provider configured.',
      },
      colName: 'Name',
      colSummary: 'Format · model',
      colActions: 'Actions',
      dragHandle: 'Drag to reorder',
      unnamedConfig: '(unnamed)',
      activePill: 'Selected for voice input',
      activePillLabel: 'voice',
      audioFileActivePill: 'Selected for audio file transcription',
      audioFileActivePillLabel: 'audio file',
      editConfigAria: 'Edit configuration',
      deleteConfigAria: 'Delete configuration',
      deleteConfigMessagePrefix: 'Delete',
      deleteConfigTitle: 'Delete ASR configuration',
      deleteConfigFailed: 'Failed to delete ASR.',
      reorderConfigFailed: 'Failed to reorder ASR.',
      emptyHint:
        'No ASR endpoint configured yet. Use "Add ASR configuration" in the header.',
      addConfig: 'Add ASR configuration',
      configName: 'Name',
      configNameDesc: 'Shown in the ASR list.',
      baseURLRequired: 'Base URL is required.',
      modelRequired: 'Model is required.',
      errorNoProvider: 'No ASR provider is configured.',
      errorLongAudioNotImplemented:
        'Long-audio provider adapters are not implemented yet.',
      errorIncompleteConfig: 'This ASR configuration is incomplete.',
      errorWebSocketMissingBaseUrl: 'This WebSocket provider needs a Base URL.',
      errorTranscriptionRequestFailed: 'ASR transcription failed: {{detail}}',
      errorChatAudioRequestFailed: 'ASR chat-audio request failed: {{detail}}',
      apiFormat: 'API format',
      apiFormatTranscription: 'Transcription',
      apiFormatChatAudio: 'Chat Audio',
      apiFormatWebSocket: 'WebSocket',
      apiFormatDescTranscription:
        'Uploads a short recording to an OpenAI-style transcription endpoint.',
      apiFormatDescChatAudio:
        'Sends the recording to a chat model that accepts audio.',
      apiFormatDescWebSocket:
        'Live WebSocket transcription. Supports Deepgram-compatible /listen and WhisperLiveKit native /asr.',
      baseURL: 'Base URL',
      baseURLDesc:
        'Enter the service base URL. Include /v1 only when the service uses it as part of the base path; configure the endpoint path below.',
      apiKey: 'API key',
      apiKeyDesc: 'Leave empty for local servers without auth.',
      apiKeyPlaceholder: 'Enter your API key',
      model: 'Model',
      modelDesc: 'Speech-to-text model id.',
      chatAudioModelDesc:
        'A multimodal chat model that accepts audio in messages.',
      deepgramWsModelDesc:
        'Deepgram model name; local compatible servers may ignore it.',
      deepgramLanguageDesc:
        'auto omits the language parameter; fill it explicitly for non-English speech, for example zh.',
      deepgramWsLanguageDesc:
        'auto omits the language parameter; fill it for non-English speech, for example zh.',
      listenPath: 'Path',
      listenPathDesc:
        'Use the path expected by the selected WS speech protocol.',
      transcriptionPath: 'Transcription path',
      transcriptionPathDesc: 'Defaults to /audio/transcriptions.',
      longAudioPathDesc:
        'Provider-specific long-audio endpoint path. Switching providers fills the matching default.',
      uploadPath: 'Upload path',
      uploadPathDesc: 'File upload endpoint path.',
      chatCompletionsPath: 'Chat completions path',
      chatCompletionsPathDesc: 'Defaults to /chat/completions.',
      audioContentFormat: 'Audio content carrier',
      audioContentFormatDesc:
        'OpenAI / OpenRouter: input_audio (base64). Aliyun Bailian: input_audio (data URL). Some vLLM mimics: audio_url.',
      chatAudioCustomParametersDesc:
        'Attach additional request fields; values accept plain text or JSON, for example { "asr_options": { "language": "zh"  } }.',
      webSocketProtocol: 'WS speech protocol',
      webSocketProtocolDesc:
        'Changing this fills the common Base URL and path for that protocol.',
      webSocketProvider: 'WebSocket provider',
      webSocketProviderDesc:
        'Changing this fills the common Base URL and path for that provider.',
      webSocketProtocolDeepgram: 'Deepgram',
      webSocketProtocolWhisperLiveKit: 'WhisperLiveKit',
      webSocketPunctuate: 'Punctuation',
      webSocketPunctuateDesc:
        'Adds punctuation and capitalization to Deepgram-compatible transcripts.',
      webSocketDiarize: 'Speaker diarization',
      webSocketDiarizeDesc:
        'Auto keeps speaker handling off for context voice input and on for audio file transcription.',
      webSocketDictation: 'Dictation commands',
      webSocketDictationDesc:
        'Turns spoken punctuation commands such as comma, period, and new line into marks. Requires punctuation.',
      webSocketFileStreamingRate: 'Rate limit',
      webSocketFileStreamingRateDesc:
        'Range 1-20, default 2. When an audio file is dropped in, stream to WhisperLiveKit at up to this realtime speed.',
      longProvider: 'Long-audio provider',
      longProviderDesc:
        'Fixed long-audio providers keep their own request and result parsing.',
      longProviderFunasr: 'FunASR local',
      longProviderDeepgram: 'Deepgram pre-recorded',
      longProviderTencent: 'Tencent Flash',
      longProviderVolcengineFlash: 'Volcengine / Doubao Flash',
      appId: 'AppID',
      appIdDesc: 'Cloud account or application ID for this provider.',
      tencentAppIdDesc:
        'Use the Tencent Cloud main account AppID, not the account ID.',
      volcengineApiKey: 'API key',
      volcengineResourceIdDesc:
        'Volcengine / Doubao resource ID, for example volc.bigasr.auc_turbo.',
      apiKeyRequired: 'API key is required.',
      apiKeyRequiredDesc: 'Required by this cloud provider.',
      apiSecret: 'APISecret',
      apiSecretDesc: 'Used only for signing ASR requests.',
      apiSecretPlaceholder: 'Enter your API secret',
      secretId: 'SecretID',
      secretKey: 'SecretKey',
      jobPath: 'Job path',
      jobPathDesc: 'Task creation endpoint. Full URLs are allowed.',
      resultPath: 'Result path',
      resultPathDesc: 'Task polling endpoint. Full URLs are allowed.',
      longAudioDiarization: 'Speaker diarization',
      longAudioDiarizationDesc:
        'Auto keeps speaker handling off for context voice input and on for audio file transcription.',
      longAudioTimestamps: 'Timestamps',
      longAudioTimestampsDesc:
        'Request provider timestamps when the API supports that option.',
      longAudioSpeakerCount: 'Speaker count',
      longAudioSpeakerCountDesc: '0 means automatic speaker count.',
      longProviderCredentialsRequired:
        'AppID, API key, and API secret are required.',
      funasrServerFeatures: 'Server features',
      funasrServerFeaturesDesc:
        'Configure punctuation and speaker diarization on the FunASR server. The plugin automatically uses returned punctuation and speaker fields.',
      longAudioPunctuation: 'Punctuation',
      longAudioPunctuationDesc:
        'Ask Deepgram to add punctuation, capitalization, and Smart Format. Turn off if the selected language produces unwanted formatting.',
      featureModeAuto: 'Auto',
      featureModeOn: 'On',
      featureModeOff: 'Off',
      addConfigShort: '+ Add',
      audioFormat: 'Audio format',
      audioFormatAuto: 'auto',
      audioFormatPcm16: 'PCM 16k',
      audioFormatWav: 'wav',
      audioFormatDescChat:
        'wav has better compatibility, but creates larger uploads.',
      audioFormatDescTranscription:
        'wav has better compatibility, but creates larger uploads.',
      audioFormatDescWebSocket:
        'PCM has better compatibility, but sends larger data.',
      transport: 'Transport',
      language: 'Language',
      languageDesc: 'Leave empty or "auto" to let the provider detect.',
      microphone: 'Microphone',
      microphoneDesc:
        'Pick a specific input device. Labels appear after granting mic permission once.',
      micDefault: 'System default',
      microphoneFallbackName: 'Microphone',
      microphoneUnlock: 'Unlock device labels',
      microphoneUnlockDesc:
        'Grants the mic permission once so device names become visible. No audio is recorded.',
      microphoneUnlockButton: 'Grant',
      testRecording: 'Test recording',
      testRecordingDesc:
        'Records a short clip with the current configuration to verify URL / key / model / format.',
      testRecordingDescWebSocket:
        'Starts a live streaming ASR test. Click Stop when done speaking.',
      testRun: 'Run test',
      testStopStreaming: 'Stop',
      testRunning: 'Recording…',
      testFinalizing: 'Stopping…',
      testFailed: 'ASR test failed.',
      testTookMs: 'Took {{ms}} ms',
      testEmptyResult: 'ASR returned empty text.',
      testStreamingRunning:
        'Streaming ASR test is running. Click Stop when done.',
      testStreamingUnsupported:
        'This ASR provider does not support streaming tests.',
      testStreamingAutoStop:
        'Streaming ASR test reached the maximum duration. Stopping…',
      testInvalidConfig: 'Invalid config.',
      testRecordingSeconds: 'Recording {{seconds}} s…',
      testCallingAsr: 'Calling ASR…',
      testBadgePassed: '✓ Passed',
      testBadgeFailed: '× Failed',
      testBadgeRecording: '● Recording',
      testBadgeFinalizing: '… Stopping',
      testBadgeTranscribing: '… Transcribing',
    },

    audioFileTranscription: {
      title: 'Audio file transcription',
      description:
        'Transcribe dropped or selected audio files through ASR and insert the transcript into the editor.',
      voiceRequiredHint:
        'Enable voice input above to show the floating island used for choosing or dropping audio files.',
      enable: 'Enable audio file transcription',
      enableDesc:
        'Adds an audio-file mode to the floating voice island. File transcription only runs ASR and does not use context-aware polishing.',
      enableDescUnavailable:
        'Add an ASR provider before enabling audio file transcription.',
      asrProvider: 'Audio file ASR provider',
      asrProviderDesc:
        'Defaults to the voice input ASR provider, but can be set separately for longer local audio files.',
      chunkHeaderMode: 'Chunk header',
      chunkHeaderModeDesc:
        'For HTTP chunked transcription, optionally insert the local chunk start time before each chunk.',
      chunkHeaderMode_none: 'No chunk headers',
      'chunkHeaderMode_local-start-time': 'Local start time',
      outputMetadataMode: 'Output metadata',
      outputMetadataModeDesc:
        'Controls whether transcription output includes file metadata and provider timestamps.',
      outputMetadataMode_none: 'Body only',
      outputMetadataMode_metadata: 'Metadata',
      'outputMetadataMode_metadata-timestamps': 'Metadata + timestamps',
      fallbackNotePathTemplate: 'Fallback note path',
      fallbackNotePathTemplateDesc:
        'Where results are saved if the transcription insertion point is unavailable. Supports {{date}}, {{time}}, {{basename}}, and {{filename}}.',
      advancedToggle: 'Advanced options',
      wavMaxDurationMin: 'Max WAV/PCM duration (minutes)',
      wavMaxDurationMinDesc:
        'Based on WAV/PCM upload-size conversion. Files beyond this limit are blocked before local conversion to avoid freezes and excessive upload traffic. Range: 1-120.',
      wavDurationLimitProviderNotice:
        'Current WAV/PCM limit is {{minutes}} minutes, based on upload-size conversion. Longer files are blocked to avoid freezes and excessive upload traffic.',
      chunkTargetDurationSec: 'Audio file chunk duration (seconds)',
      chunkTargetDurationSecDesc:
        'WAV chunks; some providers need 30s or less. Range: 15-600.',
      maxConcurrentChunks: 'Max concurrent chunks',
      maxConcurrentChunksDesc:
        'Maximum HTTP chunks in flight at once. Range: 1-5.',
      chunkStartStaggerMs: 'Chunk start stagger (ms)',
      chunkStartStaggerMsDesc:
        'Delay between starting chunk uploads, reducing rate-limit spikes. Range: 1000-3000.',
      chunkOverlapMs: 'Chunk overlap (ms)',
      chunkOverlapMsDesc:
        'Small overlap around chunk boundaries to reduce missed words. Range: 0-1500.',
      chunkDurationLimitNotice:
        'This provider has a known request-size limit for WAV chunks.',
      chunkDurationLimitSuggestion: 'Suggested chunk duration:',
      chunkDurationLimitSuffix: 'or less',
    },

    contextVoiceInput: {
      title: 'Context-aware voice input',
      description:
        'Hold or click the mic to dictate at the cursor. The polish LLM uses the current file title, surrounding text, and selection.',
      enable: 'Enable voice input',
      enableDesc:
        'Use the command palette, an Obsidian hotkey, or the floating mic to trigger it.',
      enableDescUnavailable: 'Add an ASR provider before enabling voice input.',
      asrProvider: 'ASR provider',
      asrProviderDesc:
        'Pick which of your configured ASR endpoints (Models → Voice recognition (ASR)) handles this voice input session.',
      asrProviderNone:
        '(none — add one under Models → Voice recognition (ASR))',
      polishModel: 'Polish model',
      polishModelDesc:
        'Rewrites the raw transcript with surrounding editor context. Falls back to the default chat model when unset.',
      polishTemperature: 'Polish call temperature',
      polishTemperatureDesc:
        "Default: 0.2. Leave blank to use the selected polish model's configured temperature.",
      polishTemperaturePlaceholder: 'Use model temperature',
      systemPromptMode: 'Prompt style',
      systemPromptModeDesc:
        'Pick a built-in preset or switch to custom to write your own.',
      promptMode: {
        default: 'Default (cleanup only, stay faithful)',
        translate: 'Translate (zh ⇆ en)',
        expand: 'Expand (outline → paragraph)',
        polish: 'Polish (formal / academic / literary)',
        custom: 'Custom',
      },
      builtinSystemPrompt: 'Built-in system prompt',
      builtinSystemPromptDesc:
        'Shown for review. Built-in presets are locked; switch to Custom to edit your own prompt.',
      customSystemPrompt: 'Custom system prompt',
      customSystemPromptDesc: 'Must still emit { action, text } JSON.',
      tabCompletionAlwaysPaused:
        'Tab completion is always paused while voice input is active, so Tab only accepts the voice draft.',
      beforeWindowChars: 'Initial before-cursor window (characters)',
      beforeWindowCharsDesc:
        'Initial characters of editor text BEFORE the cursor sent to the polish model. During continuous dictation, this anchored prefix grows as you accept/write text. Independent from the after-cursor window below.',
      afterWindowChars: 'After-cursor window (characters)',
      afterWindowCharsDesc:
        'Characters of editor text AFTER the cursor sent to the polish model. Helps the model avoid repeating text that already follows the cursor. Independent from the before-cursor window above. Does not limit how much text voice input can insert.',
      maxRecordingSeconds: 'Max recording (seconds)',
      maxRecordingSecondsDesc:
        'Auto-stops a forgotten recording so it does not waste ASR calls.',
      decibelMeter: 'Microphone level meter',
      decibelMeterDesc:
        'Listen locally and accumulate microphone loudness from -50 to -5 dB, so you can tune the speech and silence thresholds below. Audio is not recorded or sent.',
      decibelMeterStart: 'Start',
      decibelMeterStop: 'Stop',
      decibelMeterLevel: 'Microphone loudness distribution',
      decibelMeterPeak: 'Peak',
      decibelMeterSpeechStart: 'Speech start',
      decibelMeterSilence: 'Silence',
      decibelMeterUnavailable:
        'Microphone level meter is not available in this environment.',
      decibelMeterPermissionError:
        'Could not read the microphone. Check permission and device selection.',
      vadSpeechStartDecibels: 'Speech start threshold (dB)',
      vadSpeechStartDecibelsDesc:
        'Range: -50 to -5. More negative catches quieter speech; closer to -5 ignores more background noise. Default: -40.',
      vadSilenceDecibels: 'Silence threshold after speech (dB)',
      vadSilenceDecibelsDesc:
        'Range: -50 to -5. After speech has started, audio below this level counts as silence. Default: -36.',
      vadSpeechRequiredMs: 'Speech confirmation duration (ms)',
      vadSpeechRequiredMsDesc:
        'How long audio must stay above the speech threshold before it counts as speech. Default: 200.',
      vadSilenceHoldMs: 'Silence duration to stop (ms)',
      vadSilenceHoldMsDesc:
        'How long click-toggle mode waits after speech tails off before it sends the segment to ASR. Default: 1200.',
      floatingIslandBottomOffsetVh: 'Floating island bottom distance',
      floatingIslandBottomOffsetVhDesc:
        'Distance as a percentage of the viewport height. Default: 9.',
      advancedToggle: 'Advanced options',
      autoRestartAfterAccept: 'Keep listening after Tab accept',
      autoRestartAfterAcceptDesc:
        'Click-toggle mode only. After Tab accepts a polished draft, automatically start the next recording segment without clicking the mic again.',
      documentSummaryEnabled: 'Include document summary + hot words',
      documentSummaryEnabledDesc:
        "At recording start, ask an LLM to summarise the current file and extract ASR-confusable hot words (proper nouns, jargon, abbreviations). The summary keeps the polish model on tone and terminology; the hot words let it prefer the document's spelling when the transcript came back with a near-miss. Adds one LLM call per refresh cycle. Both stay in memory only and are dropped when Obsidian closes.",
      documentSummaryRefresh: 'Summary refresh',
      documentSummaryRefreshDesc:
        'A full-document summary is generated automatically on first voice input; this controls when it is regenerated.',
      documentSummaryRefresh_smart: 'Smart refresh',
      documentSummaryRefresh_session: 'Do not refresh this session',
      documentSummaryRefresh_15min: 'Every 15 minutes',
      documentSummaryRefresh_1hour: 'Every 1 hour',
    },
    tts: {
      title: 'Speech generation (TTS)',
      description: 'Configure text-to-speech endpoints used by read aloud.',
      addConfig: 'Add TTS',
      addConfigTitle: 'Add TTS configuration',
      editConfigTitle: 'Edit TTS config: {name}',
      empty: 'No TTS provider configured.',
      none: '(none - add one in Models)',
      colName: 'Name',
      colSummary: 'Format · voice',
      colActions: 'Actions',
      dragHandle: 'Drag to reorder',
      unnamedConfig: '(unnamed)',
      activePillLabel: 'read aloud',
      editConfigAria: 'Edit configuration',
      deleteConfigAria: 'Delete configuration',
      deleteConfigTitle: 'Delete TTS configuration',
      deleteConfigMessagePrefix: 'Delete',
      reorderFailed: 'Failed to reorder TTS configs.',
      deleteFailed: 'Failed to delete TTS config.',
      saveFailed: 'Failed to save TTS config.',
      configName: 'Name',
      configNameDesc: 'Shown in the read-aloud provider picker.',
      apiFormat: 'API format',
      apiFormatDesc: 'Choose the protocol this endpoint speaks.',
      format: {
        'openai-compatible-speech': 'OpenAI-compatible speech',
        'mimo-chat-audio-tts': 'MiMo chat audio TTS',
        'dashscope-cosyvoice': 'DashScope CosyVoice',
        'volcengine-tts-http': 'Volcengine TTS',
      },
      baseURL: 'Base URL',
      baseURLDesc: 'Do not include the path here.',
      requestPath: 'Request path',
      requestPathDesc: 'Leave blank for the adapter default.',
      apiKey: 'API key',
      apiKeyDesc: 'Leave empty for local servers without auth.',
      apiKeyPlaceholder: 'Enter your API key',
      model: 'Model',
      modelDesc: 'Model name sent to the provider.',
      voice: 'Voice',
      voiceDesc: 'Voice or speaker ID from the provider.',
      outputFormat: 'Output format',
      outputFormatDesc: 'Audio format requested from the provider.',
      transport: 'Transport',
      transportDesc:
        'HTTP path used by the desktop app. Auto is best unless a provider needs a specific path.',
      transportMode: {
        auto: 'Auto',
        obsidian: 'Obsidian requestUrl',
        browser: 'Browser fetch',
        node: 'Desktop Node fetch',
      },
      language: 'Language',
      languageDesc: 'Optional language code when the provider supports it.',
      sampleRate: 'Sample rate',
      sampleRateDesc:
        'Optional output sample rate. Leave blank for the provider default.',
      providerDefault: 'Provider default',
      speed: 'Speed',
      speedDesc:
        'Optional speaking speed multiplier. Leave blank for provider default.',
      styleInstruction: 'Style instruction',
      styleInstructionDesc:
        'Optional style or tone instruction when the provider supports it.',
      testText: 'Test text',
      testTextDesc: 'Text used only for this test.',
      testPlaying: 'Playing test audio.',
      testReady: 'Test audio is ready. Use the player below to check playback.',
      testPlayback: 'Audio playback test',
      testPlaybackDesc:
        'Replay the last generated sample to verify the browser can decode and play it.',
      testFailed: 'TTS test failed.',
      testRunning: 'Testing...',
      testRun: 'Run test',
    },
    voiceIsland: {
      title: 'Floating voice island',
      description:
        'Choose which voice modes appear in the editor floating control and in what order.',
      enable: 'Show floating voice island',
      enableDesc:
        'The island appears only when at least one visible voice mode is enabled and configured.',
      bottomOffset: 'Floating island bottom distance',
      bottomOffsetDesc:
        'Distance as a percentage of the viewport height. Default: 9.',
      dragHandle: 'Drag to reorder',
      modeReady: 'Ready',
      dictationUnavailable: 'Enable voice input and configure ASR first.',
      audioFileUnavailable:
        'Enable audio file transcription and configure ASR first.',
      readAloudUnavailable: 'Enable read aloud and configure TTS first.',
      mode: {
        'toggle-listen': 'Click to dictate',
        'hold-to-talk': 'Hold to dictate',
        'audio-file': 'Audio file',
        'read-aloud': 'Read aloud',
      },
    },
    readAloud: {
      title: 'Read aloud',
      description:
        'Read the current selection or note through a configured TTS provider.',
      enable: 'Enable read aloud',
      enableDesc:
        'Adds read aloud as a floating island mode and enables read-aloud commands.',
      enableDescUnavailable:
        'Add a TTS provider in Models before enabling read aloud.',
      ttsProvider: 'TTS provider',
      ttsProviderDesc:
        'Used for floating island read aloud and command palette actions.',
      markdownMode: 'Markdown mode',
      markdownModeOption: {
        readable: 'Readable',
        raw: 'Raw markdown',
      },
      markdownModeDesc:
        'Readable skips frontmatter/code and reads links by label; raw keeps markdown syntax.',
      advancedToggle: 'Advanced options',
      chunkTargetChars: 'Characters per segment limit',
      chunkTargetCharsDesc:
        'Long text is split up to this limit, preferring natural pauses; actual segments may be shorter. Range: 200-6000.',
      preloadSegments: 'Preload segments',
      preloadSegmentsDesc:
        'How many upcoming text segments to synthesize while the current one is playing. Higher values reduce pauses but may spend more provider quota if you stop early. Range: 0-3.',
      cacheEnabled: 'Memory cache',
      cacheEnabledDesc:
        'Keeps generated audio in memory until Obsidian closes, and reuses it only when the text, provider, model, voice, format, speed, and style match.',
      autoSave: 'Auto-save generated audio',
      autoSaveDesc:
        'Saves generated audio to the folder below and enables drag-out.',
      saveDir: 'Generated audio folder',
      saveDirDesc: 'Vault-relative folder. Absolute paths are not accepted.',
      speaker: 'Speaker',
      speakerDesc: 'Choose where read aloud and TTS tests are played.',
      speakerDefault: 'System default',
      speakerFallbackName: 'Speaker',
      speakerCurrent: 'Selected speaker',
      speakerTest: 'Test speaker',
      speakerTesting: 'Testing...',
      speakerTestPlaying: 'Playing speaker test.',
      speakerTestFailed: 'Speaker test failed.',
      speakerUnsupported:
        'Speaker selection is not supported here; playing through the system default.',
    },
  },

  voiceInput: {
    barTranscribing: 'Transcribing…',
    barPolishing: 'Polishing…',
    barReady: 'Tab to insert · Esc to discard',
    barReadyShort: 'Tab insert',
    barReadyEsc: 'Esc discard',
    buttonStart: 'Start recording',
    buttonStop: 'Stop recording',
    buttonCancel: 'Cancel voice input',
    buttonAccept: 'Insert draft',
    modeSwitchToHold: 'Click to switch to push-to-talk',
    modeSwitchToAudioFile: 'Click to switch to audio file mode',
    modeSwitchToReadAloud: 'Click to switch to read aloud',
    modeSwitchToToggle: 'Click to switch to click-toggle',
    modeSwitchUnavailable: 'No other voice mode available',
    holdToTalkHint: 'Press & hold to talk',
    audioFileDropHint: 'Drop audio to transcribe',
    audioFileCheckDropHint: 'Drop file to check audio',
    audioFileUnsupportedDropHint: 'Only audio files',
    audioFileChecking: 'Checking…',
    audioFileConfirm: 'Confirm upload',
    audioFilePreparing: 'Preparing…',
    audioFileUploading: 'Uploading…',
    audioFileInserting: 'Inserting…',
    audioFileIdleHint: 'Drop or choose audio',
    audioFileConfirmButton: 'Start upload',
    audioFileChooseButton: 'Choose audio file',
    audioFileFinished: 'Audio file transcription finished.',
    audioFileEmptyLongAudioResult:
      'Long-audio transcription finished, but the provider returned no text to insert.',
    audioFileCancelled: 'Audio file transcription cancelled.',
    audioFilePlanStream: 'Stream audio?',
    audioFilePlanChunked: 'Upload {{count}} audio chunks?',
    audioFilePlanLongAudio: 'Submit long audio?',
    audioFilePlanDirect: 'Upload this audio file for transcription?',
    audioFileProgressInsertingChunks: 'Inserting {{done}}/{{total}}…',
    audioFileProgressTranscribingChunks: 'Transcribing {{done}}/{{total}}…',
    audioFileProgressStreamingPercent: 'Streaming {{percent}}%…',
    audioFileProgressUploadingPercent: 'Uploading {{percent}}%…',
    audioFileFallbackNotice: 'Transcription is being written to {{path}}.',
    audioFileWavPcmUploadNotice:
      'This audio will send WAV/PCM data, about {{size}}. This can use much more traffic than compressed audio.',
    audioFileLargeUploadNotice:
      'This audio file is {{size}} and will be sent as-is. This may use a lot of upload traffic.',
    audioFileSubmissionChunks: '{{count}} chunks',
    audioFileSubmissionWebSocket: 'WebSocket stream',
    audioFileSubmissionLongAudio: 'long-audio provider',
    audioFileSubmissionDirect: 'direct upload',
    audioFileMetadataSource: 'Source',
    audioFileMetadataTranscribed: 'Transcribed',
    audioFileMetadataProvider: 'Provider',
    audioFileMetadataSubmission: 'Submission',
    audioFileFailed: 'Audio file transcription failed.',
    audioFileFailedWithMessage: 'Audio file transcription failed: {{message}}',
    audioFileErrorNoProvider:
      'No ASR provider is configured. Add one under Models → Voice recognition (ASR).',
    audioFileErrorLongAudioNotImplemented:
      'Long-audio provider adapters are not implemented yet.',
    audioFileErrorUnsupportedLocalFile:
      'The selected ASR configuration does not support audio file transcription. Choose a file-upload or WebSocket ASR provider.',
    audioFileErrorProviderLimitExceeded:
      "This audio file exceeds the selected ASR provider's upload limits.",
    audioFileErrorUnsupportedChunking:
      'The selected ASR provider cannot split this audio file.',
    audioFileErrorDecodeRequiredForChunking:
      'This file is too large for one request and cannot be decoded locally for chunking.',
    audioFileErrorLocalDecodeTooLarge:
      'This audio file is too large for local processing. Use a long-audio provider.',
    audioFileErrorWebSocketPcmLargeUnsupported:
      'Large files cannot be streamed as WAV/PCM. Use a long-audio provider.',
    audioFileErrorWebSocketMp4TailMoovUnsupported:
      'This m4a/mp4 file cannot be streamed directly. Use a long-audio provider, or choose PCM 16k in the WebSocket provider.',
    audioFileErrorWavPcmDurationLimitExceeded:
      'WAV/PCM upload is limited to {{minutes}} minutes to avoid freezes and excessive upload traffic. Use a long-audio provider for longer files.',
    audioFileErrorMissingChunkPlan:
      'Missing chunk plan for audio file transcription.',
    audioFileErrorChunkFailed: 'Chunk failed.',
    audioFileErrorStreamingUnsupported:
      'The selected ASR provider does not support streaming.',
    audioFileDirectChunkDurationHint:
      'If this is a provider upload-size limit, choose a shorter Audio file chunk duration (currently {{seconds}}s) so the file is split before upload.',
    audioFileChunkedChunkDurationHint:
      'If this is a provider upload-size limit, lower Audio file chunk duration (currently {{seconds}}s).',
    audioFileProviderGenericDurationHint:
      'Some providers need shorter WAV chunks.',
    audioFileProviderMaxDurationHint:
      'This provider may need WAV chunks at {{seconds}}s or less.',
    disabledNotice: 'Context-aware voice input is disabled in settings.',
    configureAsrNotice: 'Configure an ASR provider before using voice input.',
    selectPolishModelNotice:
      'Select a polish model under Voice → Context-aware voice input.',
    focusedEditorNotice: 'Voice input needs a focused editor.',
    asrConfigIncompleteNotice: 'The selected ASR provider is incomplete.',
    asrConfigMissingBaseUrlNotice:
      'The selected WebSocket provider needs a Base URL.',
    asrTranscriptionRequestFailed: 'ASR transcription failed: {{detail}}',
    asrChatAudioRequestFailed: 'ASR chat-audio request failed: {{detail}}',
    recorderPermissionDenied:
      'Microphone access was denied. Grant the permission in your system or Obsidian settings.',
    recorderNoDevice: 'No microphone was found.',
    recorderDeviceBusy: 'The microphone is busy or not readable.',
    recorderUnsupported: 'Recording is not supported in this environment.',
    recordingCancelled: 'Recording cancelled.',
    finishCurrentTaskNotice:
      'Finish the current voice task before transcribing a file.',
    managedPathTransitionNotice:
      'YOLO files are moving. Try again when the move finishes.',
    managedPathWriteTimeoutNotice:
      'Voice files are still being saved, so the YOLO root was not changed. Try again after saving finishes.',
    audioFileDisabledNotice:
      'Audio file transcription is disabled in voice input settings.',
    failed: 'Voice input failed.',
    failedWithMessage: 'Voice input failed: {{message}}',
    startRecordingFailed: 'Could not start recording.',
    noticePrefix: 'Voice polish',
    malformedOutput:
      'Voice polish returned malformed output; nothing inserted.',
    readAloudDisabledNotice: 'Read aloud is disabled in settings.',
    readAloudNoProvider: 'Configure a TTS provider before using read aloud.',
    readAloudNoText: 'No text to read aloud.',
    readAloudPreparing: 'Preparing read aloud…',
    readAloudConfirmLongText: 'Long text will play in {{segments}} segments.',
    readAloudProgress: 'Reading {{index}}/{{total}}',
    readAloudPaused: 'Paused',
    readAloudCompleted: 'Read aloud done',
    readAloudFailed: 'Read aloud failed.',
    readAloudFailedWithMessage: 'Read aloud failed: {{message}}',
    readAloudPlaying: 'Reading',
    readAloudCancelled: 'Read aloud stopped.',
    readAloudAutoSaveFailed: 'Could not save generated audio.',
    readSelection: 'Read selection',
    readNote: 'Read note',
    readAloudDragGeneratedAudio: 'Drag generated audio',
    readAloudConfirmButton: 'Start read aloud',
    readAloudPauseButton: 'Pause read aloud',
    readAloudResumeButton: 'Resume read aloud',
  },

  chat: {
    placeholder:
      'Type a message...「@ to add references or models, / to choose a skill or command」',
    placeholderCompact: 'Click to expand and edit...',
    placeholderPrefix: 'Type a message...',
    placeholderMention: 'add references or models',
    placeholderMentionReferences: 'add references',
    placeholderSkill: 'choose a skill or command',
    contextUsage: 'Context window usage',
    contextUsageUnknownMaxSuffix: ' (context window limit not set)',
    contextBreakdown: {
      title: 'Context',
      fullLabel: '{{percent}} Full',
      cacheHitLabel: 'Previous turn cache hit {{percent}}',
      breakdownBarAriaLabel: 'Context breakdown',
      usageBarAriaLabel: 'Context usage',
      tokensSuffix: 'Tokens',
      localEstimateCaption:
        'Local estimate — may differ from server-side billing.',
      unknownMaxHint:
        'Set context window tokens in model settings to show usage percentage.',
      error: 'Estimation failed',
      bucket: {
        system: 'System prompt',
        tools: 'Tools',
        rules: 'Rules',
        skills: 'Skills',
        memory: 'Memory',
        conversation: 'Conversation',
        reasoning: 'Reasoning',
      },
    },
    inlineInfo: {
      callsTitle: '{{count}} calls this turn',
      nextTurnContext: 'Context used: ~{{tokens}} tokens',
      nextTurnContextCached:
        'Context used: ~{{tokens}} tokens ({{cached}} cached)',
    },
    llmDebug: {
      title: 'LLM Debug Data',
      open: 'Open LLM debug data',
      openFailed: 'Failed to open debug data',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Failed to copy debug data',
      save: 'Save',
      savedShort: 'Saved',
      saved: 'LLM debug data saved to {{path}}',
      saveFailed: 'Failed to save debug data',
      expired: 'Debug data was cleared on restart (current session only)',
    },
    sendMessage: 'Send message',
    newChat: 'New chat',
    untitledConversation: 'New chat',
    continueResponse: 'Continue response',
    messageNavigator: {
      title: 'Message navigator',
      itemAriaLabel: 'Jump to message {index}: {label}',
      emptyMessage: 'Empty message',
    },
    mermaidControls: {
      open: 'Open diagram viewer',
      zoomOut: 'Zoom out',
      zoomIn: 'Zoom in',
      fitViewport: 'Fit diagram to window',
      reset: 'Reset zoom',
      controlsLabel: 'Diagram controls',
    },
    stopGeneration: 'Stop generation',
    queueMessage: {
      tooltip: 'Queue this message — it will be sent after the current step',
      hint: 'Waiting for the agent to finish the current step...',
      blockedApproval:
        'Approve or reject the pending tool call before sending a new message.',
      blockedAwaitingInput:
        "Answer the agent's question in the chat before sending a new message.",
      abortedRestoredOne: 'Queued message restored to the input box',
      abortedRestoredMany:
        'Restored the latest queued message to the input box ({{count}} dropped)',
    },
    askUserQuestion: {
      title: 'The agent has questions for you',
      submit: 'Submit answers',
      submitHint: 'Press Cmd / Ctrl + Enter to submit',
      cancel: 'Cancel',
      cancelTooltip: 'Dismiss the questions and end this turn',
      answeredBadge: 'Submitted',
      rejected:
        'The system rejected this question (one ask_user_question per turn, or tool disabled).',
      aborted: 'Stopped before the user could answer.',
      schemaError: 'The agent provided invalid question parameters: {{error}}',
      stale: 'This question has expired or was already handled.',
      otherOption: 'Other (please specify)',
      otherPlaceholder: 'Add your own answer…',
      otherAnswerPrefix: 'Other: ',
      otherAnswerFallback: 'Other',
      freeTextOptional: 'Optional · leave blank to submit empty',
    },
    selectModel: 'Select model',
    uploadImage: 'Upload image',
    uploadFile: 'Add file',
    dropFilesHint: 'Drop to add files',
    imageUnsupportedByModel:
      'This model has not declared image support. Enable the "Vision" input modality in the model settings to attach images.',
    unsupportedFileType: 'Unsupported file type: {names}',
    processImagesFailed: 'Failed to process uploaded images',
    readPdfFailed: 'Failed to read PDF "{name}": {error}',
    readOfficeFailed: 'Failed to read Office document "{name}": {error}',
    readTextAttachmentFailed: 'Failed to read text file "{name}": {error}',
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
    reasonedFor: 'Thought for {{seconds}}s',
    annotations: 'Annotations',
    vaultSources: 'Vault sources ({count})',
    pdfReferenceNoPreview: '(PDF: click the title to open the page)',
    assistantQuote: {
      add: 'Quote',
      badge: 'Reply quote',
      commentPlaceholder: 'Add a comment…',
      save: 'Save comment',
      delete: 'Delete comment',
      inputLabel: 'Annotation {index}',
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
      openPluginManager: {
        label: 'Manage Plugins',
        description:
          'Manage installed Claude Code plugins, or install new ones from a marketplace.',
      },
      openMcpServers: {
        label: 'MCP Servers',
        description: 'View the MCP server status for the current session.',
      },
    },
    slashMenu: {
      entrySkill: 'Skills',
      entrySnippet: 'Snippets',
      createSnippetsFile: 'Click to create snippets.md',
    },
    emptyState: {
      workspaceTitle: 'What would you like to do in {vaultName} today?',
      askTitle: 'Think first, then write',
      askDescription:
        'Great for questions, polishing, and rewriting with focus on expression.',
      chatTitle: 'Think first, then write',
      chatDescription:
        'Great for questions, polishing, and rewriting with focus on expression.',
      agentTitle: 'Let AI execute',
      agentDescription:
        'Enable tools to handle search, read/write operations, and multi-step tasks.',
      agentFullTitle: 'Let AI execute · YOLO Mode',
      agentFullDescription:
        'Auto-approve tool calls for search, read/write operations, and multi-step tasks.',
    },
    cliSurface: {
      emptyTitle: 'Use CLI Agent',
      emptyDescription:
        'Connect Claude Code or Codex to run complex tasks on this device.',
      emptyUserMessage: 'Empty message',
      error: 'CLI session error: {message}',
      runtimeError: 'Could not start the CLI runtime: {message}',
      submitError: 'Could not send the CLI message: {message}',
      cancelError: 'Could not stop the CLI run: {message}',
      openError: 'Could not open the CLI session: {message}',
      transitionError: 'Could not leave the current CLI session: {message}',
    },
    cliControls: {
      defaultModel: '{provider} default model',
      loadError: 'Could not load CLI models: {message}',
      updateError: 'Could not update CLI configuration: {message}',
    },
    claudePlugins: {
      title: 'Manage Plugins',
      placeholder: 'Loading plugin information…',
      tabInstalled: 'Installed',
      tabBrowse: 'Browse',
      loadError: 'Could not load plugin information.',
      cliFallback:
        'Plugin action failed. Manage plugins from the terminal with claude plugin instead.',
      updateRestartRequired:
        'Plugin updated. Start a new session for the change to take effect.',
      installedEmpty: 'No plugins installed yet.',
      browseEmpty: 'No matching plugins found.',
      searchPlaceholder: 'Search plugins…',
      update: 'Update',
      uninstall: 'Uninstall',
      install: 'Install',
      installedBadge: 'Installed',
      uninstallConfirmTitle: 'Uninstall plugin',
      uninstallConfirmMessage: 'Uninstall "{name}"? This cannot be undone.',
      scopeUser: 'User',
      scopeProject: 'Project',
      scopeLocal: 'Local',
      installCount: '{count} installs',
    },
    mcpServers: {
      title: 'MCP Servers',
      placeholder: 'Loading MCP server status…',
      refresh: 'Refresh',
      reconnect: 'Reconnect',
      toolCount: '{count} tools',
      statusConnected: 'Connected',
      statusFailed: 'Failed',
      statusNeedsAuth: 'Needs auth',
      statusPending: 'Connecting',
      statusDisabled: 'Disabled',
      statusUnknown: 'Unknown',
      empty: 'No MCP servers are configured for this session.',
      loadError: 'Failed to load MCP server status.',
      noActiveSession:
        'No active session yet. Send a message to start a CLI session.',
      actionError: 'Action failed: {error}',
      runtimeSwitched: 'The runtime changed, so this action was cancelled.',
      codexReadOnlyNote:
        'Codex MCP server status is read-only here. Manage servers in the terminal.',
      codexUnsupportedVersion:
        'This Codex CLI version does not support querying MCP server status. Please upgrade Codex CLI.',
    },
    quickAccess: {
      manage: 'Manage quick access',
      searchPlaceholder: 'Search skills or snippets',
      skills: 'Skills',
      snippets: 'Snippets',
      empty: 'No matches',
    },
    compaction: {
      pendingTitle: 'Compacting context',
      dividerTitle: 'Continue the current task from here',
      dividerDescription:
        'Earlier conversation has been compressed into a summary. Replies below continue from that summary',
      dividerDescriptionWithEstimate:
        'Earlier conversation has been compressed into a summary. The next-round total context is estimated at about {count} tokens',
      dividerDescriptionWithSavings:
        '{messageCount} messages compacted, saved about {tokens} tokens',
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
    todoPanel: {
      summaryPlanning: '{count} tasks pending',
      summaryInProgress: 'Step {index}/{total}: {text}',
      summaryPartial: '{done}/{total} done',
      summaryAllDone: 'All {total} done',
      expand: 'Expand',
      collapse: 'Collapse',
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
    customContinueProcessing: 'Thinking',
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
      operationCreate: 'Created',
      operationDelete: 'Deleted',
      undo: 'Undo',
      undoFile: 'Undo file change',
      undone: 'Undone',
      undoSuccess: "Undid this assistant turn's file changes.",
      undoPartial:
        'Some files were reverted, while others were skipped because they changed afterward.',
      undoUnavailable:
        'File contents have changed, so this turn cannot be safely undone.',
      undoFailed: 'Undo failed. Please try again.',
      fileDeleted: 'This file was deleted. Use undo to restore it.',
      fileMissing: 'The file no longer exists or has been moved.',
    },
    errorCard: {
      title: 'This response failed to generate',
      connectionInterruptedContinuable:
        'The connection to the model service was interrupted. Your partial response is still here—click Continue response to resume.',
      viewDetails: 'View error details',
      hideDetails: 'Hide error details',
      goToSettings: 'Go to settings',
      diagnosis: {
        auth: 'The API key is invalid. Check it and reconfigure the provider.',
        region:
          'The service is unavailable in your region. Configure a proxy or switch to an available provider.',
        model: 'The model does not exist, or you do not have access to it.',
        quota:
          'Your account balance is exhausted. Top up or switch to another provider.',
        rateLimit:
          'Too many requests in a short time. Wait a moment and retry, or switch to a model with a higher rate limit.',
        contextLength:
          'The conversation context is too long. Clear older messages or start a new chat.',
        payload: 'The request is too large. Send fewer files or less text.',
        content:
          'The content was blocked by a safety system. Revise it and try again.',
        mcp: 'The MCP server could not be reached. Check whether it is running.',
        stream:
          'The response stream was interrupted. Check your network stability or retry.',
        network:
          'Could not reach the server. Check your network or proxy settings.',
        proxy:
          'Proxy or SSL certificate error. Check your proxy and network settings.',
        server: 'The model service is having problems. Try again later.',
        deprecated:
          'This model has been retired or deprecated. Switch to another model.',
        knowledge: 'Knowledge base vectorization failed.',
        parse:
          'The model returned a malformed response. Retry or switch to another model.',
      },
      responseFormat: {
        responseNotObject:
          'The model service returned a response that is not an object (actual: {{actual}}).',
        missingChoices:
          'The model service returned a response that cannot be parsed: missing choices array.',
        invalidChoices:
          'The model service returned a response that cannot be parsed: choices is not an array (actual: {{actual}}).',
        stage: 'Stage: {{stage}}',
        expected: 'Expected field: {{field}}',
        expectedChoicesArray: 'choices array',
        responseFields: 'Response fields: {{fields}}',
        upstreamError: 'Upstream error: {{message}}',
        errorType: 'Error type: {{type}}',
        errorCode: 'Error code: {{code}}',
        upstreamMessage: 'Upstream message: {{message}}',
        responsePreview: 'Response preview: {{preview}}',
      },
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
        awaitingUserInput: 'Awaiting',
        unknown: 'Unknown',
      },
      displayName: {
        fs_list: 'List files',
        fs_search: 'Search vault',
        fs_read: 'Read files',
        fs_edit: 'Text editing',
        fs_edit_ops: 'File Editing Toolset',
        bash: 'Bash',
        memory_add: 'Add memory',
        memory_update: 'Update memory',
        memory_delete: 'Delete memory',
        open_skill: 'Open skill',
      },
      dangerousBash: {
        title: 'Dangerous operation needs confirmation',
        rmSummary: 'About to delete the following paths (moved to trash):',
        mvSummary: 'About to move/rename the following paths:',
      },
      writeAction: {
        write: 'Write file',
        delete: 'Delete',
        create_dir: 'Create folder',
        move: 'Move path',
        // Legacy keys kept for rendering historical conversations.
        create_file: 'Create file',
        delete_file: 'Delete file',
        delete_dir: 'Delete folder',
      },
      readMode: {
        full: 'Full',
        linesSuffix: ' lines',
        pagesSuffix: ' pages',
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
      rejectionReason: 'Rejection reason',
      allow: 'Allow',
      reject: 'Reject',
      abort: 'Abort',
      alwaysAllowThisTool: 'Always allow this tool',
      allowForThisChat: 'Allow for this chat',
      approvePlan: 'Approve plan',
      stayInPlan: 'Stay in plan',
    },
    toolSummary: {
      todoWrite: {
        cleared: 'Cleared list',
        allCompleted: 'All completed ({count})',
        created: 'Planned {count} tasks',
        progress: 'Progress {done}/{total}',
      },
      terminalCommand: {
        sessionPoll: 'Session {id} · Poll',
        sessionKill: 'Session {id} · Kill',
        sessionInput: 'Session {id} · Input: {preview}',
      },
    },
    toolRunSummary: {
      read: 'Read {count} file(s)',
      search: 'Searched {count} time(s)',
      web: '{count} web lookup(s)',
      edit: 'Edited {count} file(s)',
      virtualTerminal: 'Virtual terminal {count} time(s)',
      terminal: 'Terminal {count} time(s)',
      command: 'Ran {count} command(s)',
      analysis: '{count} sandbox run(s)',
      other: '{count} other action(s)',
    },
    liveTask: {
      statusRunning: 'Running',
      statusDone: 'Done',
      statusAborted: 'Aborted',
      statusError: 'Error',
      progress: 'Progress',
      output: 'Output',
      activity: 'Activity',
      abortedBeforeOutput: 'Aborted before any output was collected.',
      noActivity: 'No activity yet.',
      progressTruncated: 'Progress truncated.',
      truncated: 'Output truncated.',
    },
    subagent: {
      defaultTitle: 'Subagent',
      openDetails: 'View subagent details',
      loadingActivity: 'Loading activity…',
      planningNextMoves: 'Planning next moves',
      noActivity: 'No activity yet.',
      statusCompleted: 'Completed',
      statusAborted: 'Aborted',
      statusFailed: 'Failed',
      statusDispatched: 'Dispatched',
      toolUseCount: '{count} tools',
      tokenCount: '{count} tokens',
      approval: {
        heading: 'Awaiting approval',
        headingMulti: 'Awaiting approval · {count}',
        approve: 'Approve',
        reject: 'Reject',
        approveAll: 'Approve all',
        rejectAll: 'Reject all',
        viewDetails: 'View parameters',
      },
    },
    conversationSettings: {
      openAria: 'Conversation settings',
      chatMemory: 'Chat memory',
      maxContext: 'Maximum context',
      sampling: 'Sampling parameters',
      temperature: 'Temperature',
      topP: 'Top p',
      streaming: 'Streaming',
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
    indexedWithSkipped:
      'Index complete · {{count}} file(s) could not be indexed.',
    continueComplete: 'Resumed index completed.',
    continueFailed: 'Resumed index failed.',
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
    capturePdfNoLeaf: 'No PDF file is currently open.',
    capturePdfFailed: 'Failed to capture the selected region.',
    capturePdfInjectFailed: 'Failed to add the screenshot to chat.',
  },

  pdf: {
    regionSelectorHint: 'Drag to select a region. Press ESC to cancel.',
    toolbarButtonTooltip: 'Capture PDF region to chat',
  },

  mentionable: {
    pdfPage: 'Page {{page}}',
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
    cliStatusRunning: 'Running',
    cliStatusWaitingApproval: 'Awaiting approval',
    cliStatusWaitingUser: 'Awaiting input',
    backgroundStatusPanelTitle: 'Activity and reminders',
    backgroundStatusPanelEmpty: 'There is no activity or reminder',
    backgroundTasksRunning:
      'There are currently {count} background tasks running',
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
    acceptAllChanges: 'Accept all changes',
    keepAllChanges: 'Keep all',
    rejectAll: 'Reject all',
    rejectAllChanges: 'Reject all changes',
    revertAllChanges: 'Revert all',
    prevChange: 'Previous change',
    nextChange: 'Next change',
    reset: 'Reset',
    applyAndClose: 'Apply & close',
    acceptIncoming: 'Accept incoming',
    acceptChange: 'Accept change',
    keepChange: 'Keep this change',
    acceptCurrent: 'Accept current',
    rejectChange: 'Reject change',
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
    continuePlaceholder:
      'Leave empty to continue writing, or add instructions...',
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
    noModelConfigured:
      'No chat model configured. Please add a model in settings.',
    copied: 'Copied to clipboard',
    inserted: 'Inserted at cursor',
    rewriteSelectionExpired:
      'Selection is no longer available. Please reselect the text.',
    editPartialSuccess:
      'Applied {appliedCount} of {totalEdits} edits. Check console for details.',
    statusRequesting: 'Requesting...',
    statusThinking: 'Thinking...',
    statusGenerating: 'Generating...',
  },

  chatMode: {
    ask: 'Ask',
    askDesc: 'Ask, refine, create',
    chat: 'Chat',
    chatDesc: 'Ask, refine, create',
    rewrite: 'Rewrite',
    rewriteDesc: 'Only modify the current selection',
    agent: 'Agent',
    agentDesc: 'Tools for complex tasks',
    continue: 'Write',
    continueDesc: 'Continue writing at the cursor, press Tab to accept',
    plan: 'Plan',
    planDesc: 'Explore and design before editing',
    agentFull: 'Agent (YOLO)',
    agentFullDesc: 'Auto-approve tool calls for complex tasks',
    yolo: 'YOLO',
    yoloDesc: 'Auto-approve tool calls for complex tasks',
    fullAccessWarning: {
      title: 'Please confirm before enabling YOLO Mode',
      description:
        'YOLO Mode auto-approves all tool calls, including file edits and terminal commands. Review the risks before continuing:',
      permission:
        'Tools run without per-call approval. Dangerous command prefixes are still blocked.',
      cost: 'Autonomous runs may consume significant model resources and incur higher costs.',
      backup:
        'Back up important content in advance to avoid unintended changes.',
      checkbox:
        'I understand the risks above and accept responsibility for proceeding',
      cancel: 'Cancel',
      confirm: 'Continue with YOLO Mode',
    },
  },

  reasoning: {
    selectReasoning: 'Select reasoning',
    effort: 'Effort',
    faster: 'Faster',
    smarter: 'Smarter',
    off: 'Off',
    on: 'On',
    auto: 'Auto',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max',
    offDesc: 'No thinking, answer directly',
    autoDesc: 'Let the model decide thinking depth based on the prompt',
    lowDesc: 'Lightweight thinking, faster response',
    mediumDesc: 'Balanced thinking depth',
    highDesc: 'Deep thinking, suited for complex problems',
    xhighDesc: 'Extended thinking for highly demanding tasks',
    maxDesc: 'Maximum thinking for the most demanding tasks',
  },

  configTransfer: {
    export: {
      title: 'Export settings',
      description:
        'Select the settings to export. The file will be saved to {path}',
      selectAll: 'Select all',
      selectNone: 'Select none',
      sensitive: 'Contains credentials',
      redactedOption:
        'Redact credentials (replace API keys / passwords / headers / env vars with random strings)',
      moduleConfigsUnredactedOnly:
        'Module configuration may contain module-private credentials and is excluded from redacted exports.',
      confirmUnredactedTitle: 'Confirm export',
      confirmUnredacted:
        'This unredacted export will save API keys / passwords / headers / env vars and other sensitive data to a file in the current vault. Continue?',
      submit: 'Export',
      cancel: 'Cancel',
      noticeAtLeastOne: 'Please select at least one item',
      noticeReadFailed: 'Failed to read current settings',
      noticeSuccess: 'Settings exported to {path}',
      noticeFailed: 'Failed to export settings — check console for details',
    },
    import: {
      title: 'Import settings',
      sourceFile: 'Import from file',
      sourceFileDesc: 'Choose a previously exported .json file',
      sourceVault: 'Import from another vault',
      sourceVaultDesc: 'Choose a vault directory with YOLO installed',
      description: 'Select the settings to import',
      selectAll: 'Select all',
      selectNone: 'Select none',
      sensitive: 'Contains credentials',
      strategyOverwriteTitle: 'Overwrite',
      strategyOverwriteDesc: 'Replace selected settings with the imported ones',
      strategyMergeTitle: 'JSON merge',
      strategyMergeDesc:
        'Deep merge, keep existing values for fields not present in the import',
      submit: 'Import',
      back: 'Back',
      cancel: 'Cancel',
      noticeInvalidJson:
        'File is not valid JSON. Please pick the correct settings file.',
      noticeFileReadFailed: 'Failed to read the file. Please try again.',
      noticeRedactedHint:
        'Note: this export was redacted. All API keys / passwords / headers / env vars have been cleared and must be re-entered after import.',
      noticeRedactedReminder:
        'Note: this export was redacted. All API keys / passwords / headers / env vars have been cleared — please re-enter them in settings.',
      noticePluginNotFound:
        'No YOLO plugin settings found in the selected directory.',
      noticeAtLeastOne: 'Please select at least one item',
      noticeSuccess: 'Settings imported successfully',
      noticeFailed: 'Failed to import settings',
      noticePartialModuleConfig:
        'Host settings were imported, but module configuration import failed. Some module settings may have been written and were not rolled back.',
    },
    errors: {
      errorNotJson: 'File content is not a valid JSON object.',
      errorNotExportFile:
        'This file is not a YOLO plugin export file. Please pick a .json produced by the "Export settings" feature.',
      errorInvalidFormatVersion:
        'Invalid export format version — the file may be corrupted.',
      errorInvalidSettingsVersion:
        'Invalid settings version in the export file — it may be corrupted.',
      errorFileFromNewerVersion:
        'This file was exported by a newer plugin version ({fileVersion}); current plugin schema is {currentVersion}. Please upgrade this plugin before importing.',
      errorEmptyKeys: 'The export file contains no settings to import.',
      errorMissingData:
        'The data field is missing or invalid in the export file.',
      errorTampered:
        'Export file is inconsistent: data contains fields not declared in keys ({fields}). The file may have been tampered with.',
      errorChecksumMismatch:
        'Export file integrity check failed — the content may have been modified.',
      errorVaultParseFailed:
        'Could not parse the settings data from the target vault.',
      errorVaultMissingVersion:
        'Target vault settings are missing the version field — cannot check compatibility.',
      errorVaultFromNewerVersion:
        'Target vault uses a newer plugin version ({vaultVersion}); current is {currentVersion}. Please upgrade this plugin before importing.',
      errorVaultEmpty: 'Target vault contains no exportable settings.',
      errorApplyVersionMismatch:
        'Import data version ({importVersion}) is newer than the current plugin schema ({currentVersion}).',
      errorApplySchema:
        'The imported settings failed validation — fields may be missing or malformed.',
    },
    keyLabels: {
      providers: 'AI providers',
      chatModels: 'Chat models',
      embeddingModels: 'Embedding models',
      chatModelId: 'Default chat model',
      chatTitleModelId: 'Title-generation model',
      embeddingModelId: 'Default embedding model',
      systemPrompt: 'System prompt',
      ragOptions: 'Knowledge base settings',
      mcp: 'MCP tools',
      webSearch: 'Web search',
      skills: 'Skills',
      yolo: 'Base settings',
      debug: 'Debug settings',
      chatOptions: 'Chat preferences',
      notificationOptions: 'Notifications',
      contextVoiceInputOptions: 'Voice settings',
      continuationOptions: 'Continuation & completion',
      assistants: 'Agents',
      currentAssistantId: 'Current agent',
      quickAskAssistantId: 'Quick Ask agent',
      jsSandbox: 'JS sandbox permissions',
      pluginUpdateAutoDownloadEnabled: 'Automatically download plugin updates',
      moduleConfigs: 'Module configuration',
    },
  },

  update: {
    newVersionAvailable: 'New version {version} is available',
    toastTitle: 'YOLO · New version',
    currentVersion: 'Current',
    viewDetails: 'Check for updates',
    goUpdate: 'Update',
    dismiss: 'Dismiss',
    languageEnglish: 'EN',
    languageChinese: '中文',
    viewHistory: 'View update history',
    skipVersion: "Don't remind me for this version",
    historyTitle: 'Release history',
    historyLoading: 'Loading release history...',
    historyError: 'Failed to load release history. Please try again later.',
    historyEmpty: 'No release history found.',
    historyPage: 'Page {{current}}',
    historyPrev: 'Previous',
    historyNext: 'Next',
    installationIncompleteTitle: 'Plugin installation incomplete',
    installationIncompleteMeta:
      'main.js {mainVersion} · manifest {manifestVersion} · styles {stylesVersion}',
    installationIncompleteSuspects: 'Files to repair: {files}',
    installationIncompleteNotes:
      'Plugin files may not have downloaded completely. A repair download will start automatically; you can also retry below.',
    tryRepair: 'Try repair',
    repairing: 'Repairing {{progress}}%',
    repairAndReload: 'Repair and reload',
    downloadUpdate: 'Download update',
    downloading: 'Downloading {{progress}}%',
    backgroundDownloading: 'Downloading in background…',
    installAndReload: 'Install and reload',
    applying: 'Installing…',
    downloadFailed: 'Download failed',
    installFailed: 'Install failed',
    viewOnGitHub: 'View on GitHub',
    updateInCommunityPlugins: 'Update in community plugins',
    manualInstallOnGitHub: "Can't update? Install manually from GitHub",
  },
}
