import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { usePlugin } from '../contexts/plugin-context'
import {
  HealthCheckAbortedError,
  HealthResult,
  testChatModelHealth,
  testEmbeddingModelHealth,
} from '../core/llm/health-check'
import { ChatModel } from '../types/chat-model.types'
import { EmbeddingModel } from '../types/embedding-model.types'

const CONCURRENCY = 4

export type CellState =
  | { status: 'idle' }
  | { status: 'testing' }
  | HealthResult

export type ConnectivityPhase = 'idle' | 'running' | 'done'

export type ConnectivityCounts = {
  ok: number
  fail: number
  timeout: number
  testing: number
  idle: number
}

type TestItem =
  | { kind: 'chat'; model: ChatModel }
  | { kind: 'embedding'; model: EmbeddingModel }

export function useConnectivityTest({
  chatModels,
  embeddingModels,
}: {
  chatModels: ChatModel[]
  embeddingModels: EmbeddingModel[]
}) {
  const plugin = usePlugin()

  const items = useMemo<TestItem[]>(
    () => [
      ...chatModels.map((model) => ({ kind: 'chat' as const, model })),
      ...embeddingModels.map((model) => ({
        kind: 'embedding' as const,
        model,
      })),
    ],
    [chatModels, embeddingModels],
  )
  const total = items.length

  const initResults = useCallback(
    (): Record<string, CellState> =>
      Object.fromEntries(items.map((it) => [it.model.id, { status: 'idle' }])),
    [items],
  )

  const [results, setResults] = useState<Record<string, CellState>>(initResults)

  // Run identity guards. `activeRunIdRef` invalidates a whole batch (stop / new
  // run); `controllersRef` tracks the in-flight controller per model id. Both
  // are checked before writing a result so a late/aborted promise can never
  // overwrite fresher state — the core race in this kind of UI.
  const activeRunIdRef = useRef(0)
  const controllersRef = useRef<Map<string, AbortController>>(new Map())

  const abortAll = useCallback(() => {
    controllersRef.current.forEach((controller) => controller.abort())
    controllersRef.current.clear()
  }, [])

  const runItem = useCallback(
    async (item: TestItem, runId: number) => {
      const controller = new AbortController()
      controllersRef.current.set(item.model.id, controller)
      setResults((prev) => ({
        ...prev,
        [item.model.id]: { status: 'testing' },
      }))

      let result: HealthResult | null = null
      try {
        result =
          item.kind === 'chat'
            ? await testChatModelHealth(plugin.settings, item.model, {
                signal: controller.signal,
              })
            : await testEmbeddingModelHealth(plugin.settings, item.model, {
                signal: controller.signal,
              })
      } catch (error) {
        if (!(error instanceof HealthCheckAbortedError)) {
          result = {
            status: 'fail',
            message: error instanceof Error ? error.message : String(error),
          }
        }
      }

      // Identity guard: discard if this run was superseded or cancelled.
      if (
        activeRunIdRef.current !== runId ||
        controllersRef.current.get(item.model.id) !== controller
      ) {
        return
      }
      controllersRef.current.delete(item.model.id)
      if (result) {
        const settled = result
        setResults((prev) => ({ ...prev, [item.model.id]: settled }))
      }
    },
    [plugin],
  )

  const runPool = useCallback(
    async (batch: TestItem[], runId: number) => {
      let cursor = 0
      const workerCount = Math.min(CONCURRENCY, batch.length)
      const workers = Array.from({ length: workerCount }, async () => {
        for (;;) {
          if (activeRunIdRef.current !== runId) return
          const index = cursor
          cursor += 1
          if (index >= batch.length) return
          await runItem(batch[index], runId)
        }
      })
      await Promise.all(workers)
    },
    [runItem],
  )

  const testAll = useCallback(() => {
    abortAll()
    const runId = (activeRunIdRef.current += 1)
    setResults(initResults())
    void runPool(items, runId)
  }, [abortAll, initResults, items, runPool])

  const testOne = useCallback(
    (modelId: string) => {
      const item = items.find((it) => it.model.id === modelId)
      if (!item) return
      const existing = controllersRef.current.get(modelId)
      if (existing) existing.abort()
      void runItem(item, activeRunIdRef.current)
    },
    [items, runItem],
  )

  const stop = useCallback(() => {
    abortAll()
    activeRunIdRef.current += 1
    setResults((prev) => {
      const next = { ...prev }
      for (const id of Object.keys(next)) {
        if (next[id]?.status === 'testing') {
          next[id] = { status: 'idle' }
        }
      }
      return next
    })
  }, [abortAll])

  // Cancel everything on unmount.
  useEffect(() => {
    return () => {
      abortAll()
      activeRunIdRef.current += 1
    }
  }, [abortAll])

  const counts = useMemo<ConnectivityCounts>(() => {
    const c: ConnectivityCounts = {
      ok: 0,
      fail: 0,
      timeout: 0,
      testing: 0,
      idle: 0,
    }
    for (const item of items) {
      const status = results[item.model.id]?.status ?? 'idle'
      c[status] += 1
    }
    return c
  }, [items, results])

  const done = counts.ok + counts.fail + counts.timeout
  const phase: ConnectivityPhase =
    done === 0 && counts.testing === 0
      ? 'idle'
      : done < total
        ? 'running'
        : 'done'

  return { results, testOne, testAll, stop, counts, done, total, phase }
}
