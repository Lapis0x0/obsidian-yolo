import assert from 'node:assert/strict'
import test from 'node:test'

import {
  YOLO_DISCORD_IDS,
  isMessageInWindow,
  probeActivity,
  snowflakeFromTimestamp,
  timestampFromSnowflake,
} from './discord-triage-activity.mjs'

test('converts timestamps to Discord snowflake boundaries', () => {
  const timestamp = Date.UTC(2026, 6, 20, 12, 0, 0)
  const snowflake = snowflakeFromTimestamp(timestamp)

  assert.equal(timestampFromSnowflake(snowflake), timestamp)
})

test('initializes at the current boundary without scanning message history', async () => {
  const now = 1_800_000_000_000
  const result = await probeActivity({
    token: 'unused',
    cursor: undefined,
    now,
  })

  assert.deepEqual(result, {
    initialized: true,
    hasActivity: false,
    cursor: '',
    watermark: snowflakeFromTimestamp(now),
  })
})

test('forced runs bypass the Discord probe when a cursor exists', async () => {
  const now = 1_800_000_000_000
  const cursor = snowflakeFromTimestamp(now - 1_000)
  const result = await probeActivity({
    token: 'unused',
    cursor,
    now,
    force: true,
  })

  assert.equal(result.hasActivity, true)
  assert.equal(result.watermark, snowflakeFromTimestamp(now))
})

test('accepts only external messages inside the cursor window', () => {
  const cursor = snowflakeFromTimestamp(1_800_000_000_000)
  const inside = snowflakeFromTimestamp(1_800_000_000_100)
  const watermark = snowflakeFromTimestamp(1_800_000_000_200)

  assert.equal(
    isMessageInWindow(
      { id: inside, author: { id: 'external-user', bot: false } },
      cursor,
      watermark,
    ),
    true,
  )
  assert.equal(
    isMessageInWindow(
      { id: cursor, author: { id: 'external-user', bot: false } },
      cursor,
      watermark,
    ),
    false,
  )
  assert.equal(
    isMessageInWindow(
      {
        id: inside,
        author: { id: YOLO_DISCORD_IDS.bot, bot: true },
      },
      cursor,
      watermark,
    ),
    false,
  )
})
