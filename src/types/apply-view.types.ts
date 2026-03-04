import { TFile } from 'obsidian'

export type ApplyViewSelectionPosition = {
  line: number
  ch: number
}

export type ApplyViewSelectionRange = {
  from: ApplyViewSelectionPosition
  to: ApplyViewSelectionPosition
}

export type ApplyViewState = {
  file: TFile
  originalContent: string
  newContent: string
  reviewMode?: 'full' | 'inline-selection' | 'selection-focus'
  selectionRange?: ApplyViewSelectionRange
  selectionOriginalText?: string
  selectionNewText?: string
}
