import { TFile, TFolder } from 'obsidian'

import { buildRunAgentTaskSubmissionOptions } from './runAgentTaskSubmission'

describe('buildRunAgentTaskSubmissionOptions', () => {
  it('keeps runAgentTask submissions pinned to a fresh sidebar chat', () => {
    const file = new TFile()
    Object.assign(file, {
      path: 'docs/spec.md',
      basename: 'spec',
      extension: 'md',
    })

    const folder = new TFolder()
    Object.assign(folder, {
      path: 'docs',
      name: 'docs',
    })

    expect(
      buildRunAgentTaskSubmissionOptions({
        assistantId: 'assistant-1',
        fileToAdd: file,
        folderToAdd: folder,
      }),
    ).toEqual({
      placement: 'sidebar',
      openNewChat: true,
      assistantId: 'assistant-1',
      fileToAdd: file,
      folderToAdd: folder,
    })
  })
})
