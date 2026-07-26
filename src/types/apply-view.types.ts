import { TFile } from 'obsidian'

export type ApplyViewSelectionPosition = {
  line: number
  ch: number
}

export type ApplyViewSelectionRange = {
  from: ApplyViewSelectionPosition
  to: ApplyViewSelectionPosition
}

export type ApplyViewResult = {
  finalContent: string
}

export type ApplyReviewEdit = {
  from: number
  to: number
  replacement: string
}

export type ApplyViewCallbacks = {
  onComplete?: (result: ApplyViewResult) => void
  onCancel?: () => void
}

export type ApplyViewState = {
  file: TFile
  originalContent: string
  newContent: string
  reviewEdits?: ApplyReviewEdit[]
  viewMode?: 'apply' | 'applied-review'
  reviewMode?: 'full' | 'selection-focus'
  selectionRange?: ApplyViewSelectionRange
  callbacks?: ApplyViewCallbacks
  abortSignal?: AbortSignal
}
