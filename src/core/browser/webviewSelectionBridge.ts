import { type App, Platform } from 'obsidian'

import type { MentionableWebSelection } from '../../types/mentionable'
import {
  getBlockContentHash,
  getBlockMentionableCountInfo,
} from '../../utils/chat/mentionable'

import {
  type ActiveWebviewHandle,
  findActiveWebviewHandle,
  isWebviewLoading,
} from './activeWebviewProbe'

const POLL_INTERVAL_MS = 500

const BRIDGE_KEY = '__YOLO_WEB_SELECTION_BRIDGE__'

const INSTALL_BRIDGE_SCRIPT = `(() => {
  const key = '${BRIDGE_KEY}';
  if (!window[key]) {
    let state = {
      version: 0,
      hasSelection: false,
      text: '',
      url: String(location.href || ''),
      title: String(document.title || ''),
    };
    let timer = null;
    const readSelectionText = () => {
      const selection = window.getSelection ? window.getSelection() : null;
      return selection ? String(selection.toString() || '').trim() : '';
    };
    const update = () => {
      const text = readSelectionText();
      const next = {
        hasSelection: text.length > 0,
        text,
        url: String(location.href || ''),
        title: String(document.title || ''),
      };
      if (
        state.hasSelection === next.hasSelection &&
        state.text === next.text &&
        state.url === next.url &&
        state.title === next.title
      ) {
        return state;
      }
      state = {
        version: state.version + 1,
        ...next,
      };
      window[key].state = state;
      return state;
    };
    const schedule = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        timer = null;
        update();
      }, 200);
    };
    window[key] = {
      state,
      readNow: update,
    };
    document.addEventListener('selectionchange', schedule, true);
    document.addEventListener('mouseup', schedule, true);
    document.addEventListener('keyup', schedule, true);
    document.addEventListener('touchend', schedule, true);
    update();
  } else if (typeof window[key].readNow === 'function') {
    window[key].readNow();
  }
  return window[key].state.version;
})()`

const READ_VERSION_SCRIPT = `(() => {
  const bridge = window['${BRIDGE_KEY}'];
  return bridge && bridge.state ? bridge.state.version : -1;
})()`

const READ_STATE_SCRIPT = `(() => {
  const bridge = window['${BRIDGE_KEY}'];
  if (!bridge || typeof bridge.readNow !== 'function') return null;
  return bridge.readNow();
})()`

type BridgeState = {
  version: number
  hasSelection: boolean
  text: string
  url: string
  title: string
}

const isBridgeState = (value: unknown): value is BridgeState => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.version === 'number' &&
    typeof record.hasSelection === 'boolean' &&
    typeof record.text === 'string' &&
    typeof record.url === 'string' &&
    typeof record.title === 'string'
  )
}

const toWebSelectionMentionable = (
  handle: ActiveWebviewHandle,
  state: BridgeState,
): MentionableWebSelection => {
  const info = getBlockMentionableCountInfo(state.text)
  return {
    type: 'web-selection',
    content: state.text,
    url: state.url || handle.webview.getURL(),
    title: state.title || handle.webview.getTitle(),
    pageId: handle.pageId,
    source: 'web-selection-sync',
    contentHash: getBlockContentHash(state.text),
    contentCount: info.count,
    contentUnit: info.unit,
  }
}

export class WebviewSelectionBridge {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private activePageId: string | null = null
  private activeVersion = -1
  private lastSelectionKey: string | null = null
  private running = false

  constructor(
    private readonly app: App,
    private readonly options: {
      isEnabled: () => boolean
      onSelection: (selection: MentionableWebSelection) => void
      onClear: () => void
    },
  ) {}

  start(): void {
    if (this.intervalId !== null) return
    this.intervalId = setInterval(() => {
      void this.tick()
    }, POLL_INTERVAL_MS)
    void this.tick()
  }

  destroy(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.activePageId = null
    this.activeVersion = -1
    this.clearSyncedSelection()
  }

  noteWorkspaceChange(): void {
    void this.tick()
  }

  private async tick(): Promise<void> {
    if (this.running) return
    if (!this.options.isEnabled() || Platform.isMobile) {
      this.resetActiveState({ clearSelection: true })
      return
    }

    this.running = true
    try {
      const handle = findActiveWebviewHandle(this.app)
      if (!handle || isWebviewLoading(handle.webview)) {
        this.resetActiveState({ clearSelection: true })
        return
      }

      if (this.activePageId !== handle.pageId) {
        this.clearSyncedSelection()
        this.activePageId = handle.pageId
        this.activeVersion = -1
      }

      await handle.webview.executeJavaScript(INSTALL_BRIDGE_SCRIPT)
      const rawVersion =
        await handle.webview.executeJavaScript(READ_VERSION_SCRIPT)
      const version = typeof rawVersion === 'number' ? rawVersion : -1
      if (version === this.activeVersion) return

      this.activeVersion = version
      const rawState = await handle.webview.executeJavaScript(READ_STATE_SCRIPT)
      if (!isBridgeState(rawState)) return

      if (!rawState.hasSelection || rawState.text.trim().length === 0) {
        if (this.lastSelectionKey !== null) {
          this.lastSelectionKey = null
          this.options.onClear()
        }
        return
      }

      const selection = toWebSelectionMentionable(handle, rawState)
      const key = `${selection.pageId}:${selection.url}:${selection.contentHash}`
      if (key === this.lastSelectionKey) return
      this.lastSelectionKey = key
      this.options.onSelection(selection)
    } catch {
      this.resetActiveState({ clearSelection: true })
    } finally {
      this.running = false
    }
  }

  private resetActiveState(options?: { clearSelection?: boolean }): void {
    this.activePageId = null
    this.activeVersion = -1
    if (options?.clearSelection) {
      this.clearSyncedSelection()
    } else {
      this.lastSelectionKey = null
    }
  }

  private clearSyncedSelection(): void {
    if (this.lastSelectionKey === null) return
    this.lastSelectionKey = null
    this.options.onClear()
  }
}
