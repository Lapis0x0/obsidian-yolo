import { TFile } from 'obsidian'

export type ApplyViewState = {
  file: TFile
  originalContent: string
  newContent: string
}
