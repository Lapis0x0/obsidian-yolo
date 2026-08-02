import {
  decodeCodexExecEnvelope,
  splitCodexExecEnvelopeOutput,
} from './exec-envelope'

describe('Codex exec envelope', () => {
  it('decodes parallel static tool calls without executing source', () => {
    expect(
      decodeCodexExecEnvelope(`
        const results = await Promise.all([
          tools.exec_command({cmd: "pwd", workdir: "/vault"}),
          tools.get_goal({}),
          tools.list_mcp_resources({server: "exa"})
        ]);
        text(JSON.stringify(results));
      `),
    ).toEqual([
      { name: 'exec_command', input: { command: 'pwd', cwd: '/vault' } },
      { name: 'get_goal', input: {} },
      { name: 'list_mcp_resources', input: { server: 'exa' } },
    ])
  })

  it('resolves a patch variable and rejects dynamic expressions', () => {
    expect(
      decodeCodexExecEnvelope(
        `const patch = "*** Begin Patch\\n*** End Patch"; await tools.apply_patch(patch);`,
      ),
    ).toEqual([
      {
        name: 'apply_patch',
        input: { patch: '*** Begin Patch\n*** End Patch' },
      },
    ])
    expect(
      decodeCodexExecEnvelope('await tools.exec_command({cmd: commandName})'),
    ).toBeNull()
  })

  it('splits the outer transport header from per-tool outputs', () => {
    expect(
      splitCodexExecEnvelopeOutput(
        [
          {
            type: 'input_text',
            text: 'Script completed\nWall time 0.1s\nOutput:\n',
          },
          { type: 'input_text', text: 'first' },
          { type: 'input_text', text: 'second' },
        ],
        2,
      ),
    ).toEqual(['first', 'second'])
  })
})
