import { getLocalFileToolServerName } from '../../mcp/localFileTools'
import { getToolName } from '../../mcp/tool-name-utils'

export const LEARNING_READONLY_TOOL_NAMES = [
  getToolName(getLocalFileToolServerName(), 'fs_read'),
  getToolName(getLocalFileToolServerName(), 'fs_list'),
]
