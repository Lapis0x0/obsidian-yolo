import type { Assistant } from '../../types/assistant.types'

import { resolveWorkspaceScopeForRuntimeInput } from './chat-runtime-inputs'

describe('chat-runtime-inputs', () => {
  it('passes through assistant workspace scope when present', () => {
    const scope = {
      enabled: true,
      include: ['notes/'],
      exclude: [],
    }
    const assistant = {
      workspaceScope: scope,
    } as unknown as Assistant

    expect(resolveWorkspaceScopeForRuntimeInput(assistant)).toEqual(scope)
  })

  it("lets a project's scope replace the assistant's, tagged with the project", () => {
    const assistant = {
      workspaceScope: { enabled: true, include: ['notes/'], exclude: [] },
    } as unknown as Assistant
    const projectScope = { enabled: true, include: ['thesis/'], exclude: [] }
    expect(
      resolveWorkspaceScopeForRuntimeInput(assistant, {
        id: 'p',
        name: 'P',
        workspaceScope: projectScope,
        createdAt: 0,
        updatedAt: 0,
      }),
    ).toEqual({ ...projectScope, projectId: 'p' })
  })

  it('returns undefined workspace scope when assistant is missing or has none', () => {
    expect(resolveWorkspaceScopeForRuntimeInput(null)).toBeUndefined()
    expect(
      resolveWorkspaceScopeForRuntimeInput({
        id: 'a',
        name: 'A',
        systemPrompt: '',
      } as Assistant),
    ).toBeUndefined()
  })
})
