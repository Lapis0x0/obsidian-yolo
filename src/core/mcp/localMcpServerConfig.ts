import type { YoloSettings } from '../../settings/schema/setting.types'

/**
 * 27123/27124 belong to the Local REST API plugin, which listens inside the
 * same Obsidian process — sharing that default made every install with both
 * plugins fail to bind. Existing configs keep whatever port they stored.
 */
export const DEFAULT_LOCAL_MCP_SERVER_PORT = 28124
export const LOCAL_MCP_SERVER_HOST = '127.0.0.1'
export const LOCAL_MCP_SERVER_PATH = '/mcp'

export type LocalMcpServerStatus = 'stopped' | 'starting' | 'running' | 'error'

export type LocalMcpServerState = {
  status: LocalMcpServerStatus
  url: string
  error?: string
}

export type LocalMcpServerRuntime = {
  initialize(): Promise<void>
  updateSettings(settings: YoloSettings): Promise<void>
  close(): Promise<void>
  getState(): LocalMcpServerState
  subscribe(listener: (state: LocalMcpServerState) => void): () => void
}

export const getLocalMcpServerUrl = (port: number): string =>
  `http://${LOCAL_MCP_SERVER_HOST}:${port}${LOCAL_MCP_SERVER_PATH}`

export const generateLocalMcpServerToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}
