import type { StateSnapshot } from 'react-virtuoso'

import type { ChatTimelineItem } from '../../types/chat-timeline'

const WIDTH_BUCKET_SIZE = 80
const HEIGHT_CHANGE_THRESHOLD = 1
const MAX_SCOPE_ENTRIES = 80
const DEFAULT_WIDTH_BUCKET = 0
const DEFAULT_STYLE_SIGNATURE = 'default'

export type TimelineCacheScope = {
  conversationId: string
  widthBucket: number
  styleSignature: string
}

type HeightCacheEntry = {
  updatedAt: number
  valueByItemId: Map<string, number>
}

type StateCacheEntry = {
  timelineSignature: string
  snapshot: StateSnapshot
  updatedAt: number
}

const heightCacheByScope = new Map<string, HeightCacheEntry>()
const stateCacheByScope = new Map<string, StateCacheEntry>()

const getScopeKey = ({
  conversationId,
  widthBucket,
  styleSignature,
}: TimelineCacheScope): string => {
  return `${conversationId}::${widthBucket}::${styleSignature}`
}

const pruneOldestEntry = <
  TEntry extends {
    updatedAt: number
  },
>(
  cache: Map<string, TEntry>,
) => {
  if (cache.size <= MAX_SCOPE_ENTRIES) {
    return
  }

  let oldestKey: string | null = null
  let oldestUpdatedAt = Number.POSITIVE_INFINITY
  for (const [key, entry] of cache) {
    if (entry.updatedAt < oldestUpdatedAt) {
      oldestUpdatedAt = entry.updatedAt
      oldestKey = key
    }
  }
  if (oldestKey) {
    cache.delete(oldestKey)
  }
}

export const getTimelineWidthBucket = (width: number): number => {
  if (!Number.isFinite(width) || width <= 0) {
    return DEFAULT_WIDTH_BUCKET
  }

  return Math.max(
    WIDTH_BUCKET_SIZE,
    Math.round(width / WIDTH_BUCKET_SIZE) * WIDTH_BUCKET_SIZE,
  )
}

export const getTimelineStyleSignature = (
  element: HTMLElement | null,
): string => {
  if (!element || typeof window === 'undefined') {
    return DEFAULT_STYLE_SIGNATURE
  }

  const styles = window.getComputedStyle(element)
  const fontSize = styles.fontSize || 'na'
  const lineHeight = styles.lineHeight || 'na'
  const fontFamily = styles.fontFamily || 'na'
  const renderScale = styles.getPropertyValue('--render-scale').trim() || 'na'
  const paragraphSpacing = styles.getPropertyValue('--p-spacing').trim() || 'na'
  const headingSpacing =
    styles.getPropertyValue('--heading-spacing').trim() || 'na'

  return [
    fontSize,
    lineHeight,
    fontFamily,
    renderScale,
    paragraphSpacing,
    headingSpacing,
  ].join('|')
}

export const buildTimelineSignature = (items: ChatTimelineItem[]): string => {
  if (items.length === 0) {
    return '0|empty'
  }

  return `${items.length}|${items
    .map((item) => `${item.kind}:${item.renderKey}`)
    .join('|')}`
}

export const getTimelineHeightCache = (
  scope: TimelineCacheScope,
): ReadonlyMap<string, number> | null => {
  return heightCacheByScope.get(getScopeKey(scope))?.valueByItemId ?? null
}

export type TimelineHeightCacheSnapshot = {
  scope: TimelineCacheScope
  updatedAt: number
  heights: Record<string, number>
}

export const listTimelineHeightCacheSnapshots = (
  conversationId: string,
): TimelineHeightCacheSnapshot[] => {
  const snapshots: TimelineHeightCacheSnapshot[] = []

  for (const [scopeKey, entry] of heightCacheByScope.entries()) {
    if (!scopeKey.startsWith(`${conversationId}::`)) {
      continue
    }

    const heights = Object.fromEntries(entry.valueByItemId.entries())
    const [_, widthBucketRaw, ...styleSignatureParts] = scopeKey.split('::')
    snapshots.push({
      scope: {
        conversationId,
        widthBucket: Number(widthBucketRaw),
        styleSignature: styleSignatureParts.join('::'),
      },
      updatedAt: entry.updatedAt,
      heights,
    })
  }

  snapshots.sort((left, right) => right.updatedAt - left.updatedAt)
  return snapshots
}

export const hydrateTimelineHeightCache = (
  snapshots: TimelineHeightCacheSnapshot[],
): void => {
  for (const snapshot of snapshots) {
    const scopeKey = getScopeKey(snapshot.scope)
    heightCacheByScope.set(scopeKey, {
      updatedAt: snapshot.updatedAt,
      valueByItemId: new Map(Object.entries(snapshot.heights)),
    })
  }
  pruneOldestEntry(heightCacheByScope)
}

export const clearTimelineHeightCache = (conversationId?: string): void => {
  if (!conversationId) {
    heightCacheByScope.clear()
    return
  }

  const scopeKeyPrefix = `${conversationId}::`
  for (const scopeKey of heightCacheByScope.keys()) {
    if (scopeKey.startsWith(scopeKeyPrefix)) {
      heightCacheByScope.delete(scopeKey)
    }
  }
}

export const updateTimelineItemHeight = (
  scope: TimelineCacheScope,
  itemId: string,
  height: number,
): boolean => {
  const normalizedHeight = Math.max(1, Math.ceil(height))
  const scopeKey = getScopeKey(scope)
  const now = Date.now()
  const entry =
    heightCacheByScope.get(scopeKey) ??
    ({
      updatedAt: now,
      valueByItemId: new Map<string, number>(),
    } satisfies HeightCacheEntry)

  const previousHeight = entry.valueByItemId.get(itemId)
  if (
    typeof previousHeight === 'number' &&
    Math.abs(previousHeight - normalizedHeight) < HEIGHT_CHANGE_THRESHOLD
  ) {
    entry.updatedAt = now
    heightCacheByScope.set(scopeKey, entry)
    return false
  }

  entry.valueByItemId.set(itemId, normalizedHeight)
  entry.updatedAt = now
  heightCacheByScope.set(scopeKey, entry)
  pruneOldestEntry(heightCacheByScope)
  return true
}

export const getTimelineStateSnapshot = ({
  scope,
  timelineSignature,
}: {
  scope: TimelineCacheScope
  timelineSignature: string
}): StateSnapshot | null => {
  const entry = stateCacheByScope.get(getScopeKey(scope))
  if (!entry || entry.timelineSignature !== timelineSignature) {
    return null
  }
  return entry.snapshot
}

export const setTimelineStateSnapshot = ({
  scope,
  timelineSignature,
  snapshot,
}: {
  scope: TimelineCacheScope
  timelineSignature: string
  snapshot: StateSnapshot
}): void => {
  stateCacheByScope.set(getScopeKey(scope), {
    timelineSignature,
    snapshot,
    updatedAt: Date.now(),
  })
  pruneOldestEntry(stateCacheByScope)
}
