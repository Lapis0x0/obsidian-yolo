import type { TFile, TFolder } from 'obsidian'

export type RunAgentTaskSubmissionOptions = {
  assistantId?: string
  fileToAdd?: TFile
  folderToAdd?: TFolder
  placement: 'sidebar'
  openNewChat: true
}

export function buildRunAgentTaskSubmissionOptions(input: {
  assistantId?: string
  fileToAdd?: TFile
  folderToAdd?: TFolder
}): RunAgentTaskSubmissionOptions {
  return {
    placement: 'sidebar',
    openNewChat: true,
    assistantId: input.assistantId,
    fileToAdd: input.fileToAdd,
    folderToAdd: input.folderToAdd,
  }
}
