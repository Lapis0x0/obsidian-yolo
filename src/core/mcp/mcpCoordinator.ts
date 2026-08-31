import { App } from 'obsidian'

import { YoloSettings } from '../../settings/schema/setting.types'
import type { ApplyViewState } from '../../types/apply-view.types'
import type { PromptSourceWatcher } from '../agent/promptSourceWatcher'
import {
  type RegisteredModuleChatModeV1,
  createModuleChatModeToolServer,
} from '../modules/moduleChatModeRegistry'
import type { RagKnowledgeAccess } from '../rag/ragAccess'
import type { ToolContext } from '../tools/types'

import { McpManager } from './mcpManager'

/** The subset of `ModuleChatModeRegistry` the coordinator needs to replay
 * module chat mode tool servers onto the MCP manager. */
export type ModuleChatModeRegistrySource = Readonly<{
  getSnapshot(): readonly RegisteredModuleChatModeV1[]
  subscribe(listener: () => void): () => void
  setAvailability(
    fullModeId: string,
    availability:
      | Readonly<{ status: 'available' }>
      | Readonly<{ status: 'unavailable'; reason: string }>,
  ): void
}>

type McpCoordinatorDeps = {
  app: App
  pluginId: string
  getSettings: () => YoloSettings
  openApplyReview: (state: ApplyViewState) => Promise<boolean>
  registerSettingsListener: (
    listener: (settings: YoloSettings) => void,
  ) => () => void
  ragAccess?: RagKnowledgeAccess
  promptSourceWatcher?: PromptSourceWatcher
  runSubagent?: NonNullable<ToolContext['runSubagent']>
  /**
   * Source of module chat mode declarations to replay onto the MCP manager
   * as in-process tool servers (see `reconcileChatModes`). Optional so
   * hosts/tests that don't need module chat modes can omit it.
   */
  moduleChatModeRegistry?: ModuleChatModeRegistrySource
}

export class McpCoordinator {
  private readonly app: App
  private readonly pluginId: string
  private readonly getSettings: () => YoloSettings
  private readonly openApplyReview: McpCoordinatorDeps['openApplyReview']
  private readonly registerSettingsListener: (
    listener: (settings: YoloSettings) => void,
  ) => () => void
  private readonly ragAccess?: RagKnowledgeAccess
  private readonly promptSourceWatcher?: PromptSourceWatcher
  private readonly runSubagent?: NonNullable<ToolContext['runSubagent']>
  private readonly moduleChatModeRegistry?: ModuleChatModeRegistrySource

  private mcpManager: McpManager | null = null
  private mcpManagerInitPromise: Promise<McpManager> | null = null

  // Module chat mode replay state. `registeredChatModeServers` tracks the
  // dispose function for every mode currently registered on `mcpManager`, so
  // reconciliation can diff "desired" (registry snapshot) against "actual"
  // (this map) instead of blindly re-registering.
  private chatModeUnsubscribe: (() => void) | null = null
  private readonly registeredChatModeServers = new Map<string, () => void>()
  private reconcilingChatModes = false

  constructor(deps: McpCoordinatorDeps) {
    this.app = deps.app
    this.pluginId = deps.pluginId
    this.getSettings = deps.getSettings
    this.openApplyReview = deps.openApplyReview
    this.registerSettingsListener = deps.registerSettingsListener
    this.ragAccess = deps.ragAccess
    this.promptSourceWatcher = deps.promptSourceWatcher
    this.runSubagent = deps.runSubagent
    this.moduleChatModeRegistry = deps.moduleChatModeRegistry
  }

  async getMcpManager(): Promise<McpManager> {
    if (this.mcpManager) {
      return this.mcpManager
    }

    if (!this.mcpManagerInitPromise) {
      this.mcpManagerInitPromise = (async () => {
        try {
          const manager = new McpManager({
            app: this.app,
            pluginId: this.pluginId,
            settings: this.getSettings(),
            openApplyReview: this.openApplyReview,
            registerSettingsListener: this.registerSettingsListener,
            ragAccess: this.ragAccess,
            promptSourceWatcher: this.promptSourceWatcher,
            runSubagent: this.runSubagent,
          })
          await manager.initialize()
          this.mcpManager = manager
          this.setupChatModeReplay(manager)
          return manager
        } catch (error) {
          this.mcpManager = null
          this.mcpManagerInitPromise = null
          throw error
        }
      })()
    }

    return this.mcpManagerInitPromise
  }

  cleanup() {
    this.chatModeUnsubscribe?.()
    this.chatModeUnsubscribe = null
    // The manager instance itself is being discarded, so there's nothing to
    // unregister from it — just forget what we thought was registered. A
    // later `getMcpManager()` call builds a fresh manager and replays from
    // the registry's current snapshot onto it via `setupChatModeReplay`.
    this.registeredChatModeServers.clear()
    if (this.mcpManager) {
      this.mcpManager.cleanup()
    }
    this.mcpManager = null
    this.mcpManagerInitPromise = null
  }

  /** Subscribes to the module chat mode registry and reconciles once
   * immediately, so a manager built after modes are already registered (or
   * rebuilt after `cleanup()`) still ends up with every mode replayed. */
  private setupChatModeReplay(manager: McpManager): void {
    const registry = this.moduleChatModeRegistry
    if (!registry) return
    this.reconcileChatModes(manager, registry.getSnapshot())
    this.chatModeUnsubscribe = registry.subscribe(() => {
      // Guards against a notification arriving for a manager instance
      // `cleanup()` has already discarded (unsubscribe happens in
      // `cleanup()`, but a synchronous notification mid-teardown could race
      // it in theory) — never reconcile against a stale manager.
      if (this.mcpManager !== manager) return
      this.reconcileChatModes(manager, registry.getSnapshot())
    })
  }

  /**
   * Idempotent diff/reconcile: computes the desired set of module-mode
   * in-process tool servers from the registry snapshot, registers any that
   * are missing, and unregisters any that are no longer desired. A single
   * server's registration failure (e.g. its name collides with a pre-existing
   * user-configured MCP server) marks only that mode `unavailable` and logs a
   * warning — it never aborts the rest of the reconcile pass.
   */
  private reconcileChatModes(
    manager: McpManager,
    snapshot: readonly RegisteredModuleChatModeV1[],
  ): void {
    const registry = this.moduleChatModeRegistry
    if (!registry) return
    // `setAvailability` below re-emits the registry snapshot, which would
    // otherwise reenter this method synchronously (via `chatModeUnsubscribe`'s
    // listener) mid-loop. The guard makes that reentrant call a no-op; the
    // outer call already iterates the full, current snapshot to completion.
    if (this.reconcilingChatModes) return
    this.reconcilingChatModes = true
    try {
      const desired = new Map(
        snapshot.map((entry) => [entry.fullModeId, entry] as const),
      )

      for (const [fullModeId, dispose] of [...this.registeredChatModeServers]) {
        if (desired.has(fullModeId)) continue
        dispose()
        this.registeredChatModeServers.delete(fullModeId)
      }

      for (const [fullModeId, entry] of desired) {
        if (this.registeredChatModeServers.has(fullModeId)) continue
        try {
          const dispose = manager.registerInProcessServer(
            entry.serverName,
            createModuleChatModeToolServer(entry.mode.tools ?? []),
          )
          this.registeredChatModeServers.set(fullModeId, dispose)
          registry.setAvailability(fullModeId, { status: 'available' })
        } catch (error) {
          console.warn(
            `[YOLO] Module chat mode "${fullModeId}" tool server registration failed`,
            error,
          )
          registry.setAvailability(fullModeId, {
            status: 'unavailable',
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      this.reconcilingChatModes = false
    }
  }
}
