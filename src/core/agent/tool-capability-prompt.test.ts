import { buildToolCapabilityPrompt } from './tool-capability-prompt'

describe('buildToolCapabilityPrompt', () => {
  it('explains Ask mode restrictions and the Agent configuration boundary', () => {
    const prompt = buildToolCapabilityPrompt({
      mode: 'ask',
      toolNames: ['yolo_local__fs_read'],
    })

    expect(prompt).toContain('Ask mode')
    expect(prompt).toContain(
      'file editing, path operations, and terminal commands',
    )
    expect(prompt).toContain('switch to Agent mode')
    expect(prompt).toContain("selected Agent's enabled tools")
  })

  it('lists only action capabilities missing from the Agent configuration', () => {
    const prompt = buildToolCapabilityPrompt({
      mode: 'agent',
      toolNames: ['yolo_local__terminal_command'],
    })

    expect(prompt).toContain('file editing and path operations')
    expect(prompt).not.toContain('terminal commands')
    expect(prompt).toContain('not enabled for this Agent')
  })

  it('omits the Agent capability prompt when all action capabilities exist', () => {
    const prompt = buildToolCapabilityPrompt({
      mode: 'agent',
      toolNames: [
        'yolo_local__fs_edit',
        'yolo_local__fs_delete',
        'yolo_local__terminal_command',
      ],
    })

    expect(prompt).toBeUndefined()
  })
})
