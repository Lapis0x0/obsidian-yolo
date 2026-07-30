import { Platform } from 'obsidian'

import type { CliRuntimeId } from './types'

export const isCliRuntimeAvailable = (): boolean => Platform.isDesktop

export const assertCliRuntimeAvailable = (runtimeId: CliRuntimeId): void => {
  if (!isCliRuntimeAvailable()) {
    throw new Error(`${runtimeId} CLI runtime is only available on desktop.`)
  }
}
