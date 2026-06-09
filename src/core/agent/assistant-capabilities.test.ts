import type { YoloSettings } from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'

import {
  resolveAssistantIncludeCurrentFileContent,
  resolveAssistantTimeContextEnabled,
} from './assistant-capabilities'

const baseSettings = {
  timeContextEnabled: true,
  chatOptions: { includeCurrentFileContent: true },
} as YoloSettings

describe('assistant-capabilities', () => {
  it('prefers per-agent focus sync over the global default', () => {
    const assistant = {
      id: 'a1',
      name: 'A',
      includeCurrentFileContent: false,
    } as Assistant

    expect(
      resolveAssistantIncludeCurrentFileContent(assistant, baseSettings),
    ).toBe(false)
  })

  it('falls back to global focus sync when assistant has no value', () => {
    const assistant = { id: 'a1', name: 'A' } as Assistant
    const settings = {
      ...baseSettings,
      chatOptions: { includeCurrentFileContent: false },
    } as YoloSettings

    expect(resolveAssistantIncludeCurrentFileContent(assistant, settings)).toBe(
      false,
    )
  })

  it('prefers per-agent time awareness over the global default', () => {
    const assistant = {
      id: 'a1',
      name: 'A',
      timeContextEnabled: false,
    } as Assistant

    expect(resolveAssistantTimeContextEnabled(assistant, baseSettings)).toBe(
      false,
    )
  })

  it('falls back to global time awareness when assistant has no value', () => {
    const assistant = { id: 'a1', name: 'A' } as Assistant
    const settings = {
      ...baseSettings,
      timeContextEnabled: false,
    } as YoloSettings

    expect(resolveAssistantTimeContextEnabled(assistant, settings)).toBe(false)
  })
})
