import { useSyncExternalStore } from 'react'

import { subagentTaskRegistry } from '../core/agent/subagent/task-registry'
import type { SubagentTaskRecord } from '../core/agent/subagent/types'

export function useSubagentTask(
  taskId: string | undefined,
): SubagentTaskRecord | null {
  return useSyncExternalStore(
    (onStoreChange) => subagentTaskRegistry.subscribe(() => onStoreChange()),
    () => (taskId ? (subagentTaskRegistry.get(taskId) ?? null) : null),
    () => null,
  )
}
