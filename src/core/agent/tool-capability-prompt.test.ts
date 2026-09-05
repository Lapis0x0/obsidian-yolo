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
        'yolo_local__bash',
        'yolo_local__terminal_command',
      ],
    })

    expect(prompt).toBeUndefined()
  })

  describe('max mode', () => {
    it('measures Max against its own toolset, not the vault-API one it never exposes', () => {
      // A fully-equipped Max run. Under the Agent table this would falsely
      // report file editing and path operations as unavailable, since none of
      // fs_edit / fs_write / bash exist in this mode at all.
      const prompt = buildToolCapabilityPrompt({
        mode: 'max',
        toolNames: [
          'yolo_local__read_file',
          'yolo_local__write_file',
          'yolo_local__edit_file',
          'yolo_local__terminal_command',
        ],
      })

      expect(prompt).toBeUndefined()
    })

    it('reports a capability the user actually turned off, without telling the model to switch modes', () => {
      const prompt = buildToolCapabilityPrompt({
        mode: 'max',
        toolNames: ['yolo_local__read_file', 'yolo_local__edit_file'],
      })

      expect(prompt).toContain('terminal commands')
      expect(prompt).not.toContain('file editing')
      expect(prompt).toContain('Max configuration')
      expect(prompt).toContain('disabled in settings')
      // Ask's "switch modes" framing has nowhere to point from Max.
      expect(prompt).not.toContain('switch to')
    })
  })
})
