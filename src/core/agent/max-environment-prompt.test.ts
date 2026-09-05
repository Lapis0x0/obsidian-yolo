import { buildMaxEnvironmentPrompt } from './max-environment-prompt'

describe('buildMaxEnvironmentPrompt', () => {
  const facts = {
    cwd: '/Users/me/Notes',
    platform: 'darwin',
    arch: 'arm64',
    shell: 'posix' as const,
    date: '2026-09-05',
  }

  it('states the facts nothing else in the prompt carries', () => {
    const prompt = buildMaxEnvironmentPrompt(facts)

    // Without the cwd the model cannot know what a relative path means, and
    // no other system section carries it.
    expect(prompt).toContain('Working directory: /Users/me/Notes')
    expect(prompt).toContain('darwin (arm64)')
    expect(prompt).toContain('Shell: posix')
    expect(prompt).toContain('Today: 2026-09-05')
    expect(prompt.startsWith('<max_environment>')).toBe(true)
    expect(prompt.endsWith('</max_environment>')).toBe(true)
  })

  it('names the vault-API tools it must not call, since both toolsets do "edit a file"', () => {
    const prompt = buildMaxEnvironmentPrompt(facts)

    expect(prompt).toContain('read_file, write_file and edit_file')
    expect(prompt).toContain('fs_read, fs_edit, fs_write, bash')
  })

  it('carries the tool discipline the mode depends on being followed', () => {
    const prompt = buildMaxEnvironmentPrompt(facts)

    // Prefer the reviewable edit over shell text substitution.
    expect(prompt).toContain('Prefer edit_file over')
    expect(prompt).toContain('sed')
    // Read before edit — edit_file requires an exact unique match.
    expect(prompt).toContain('Read a file before you edit it')
    // Out-of-vault reach pauses for approval, and that approval can be held
    // for the rest of the chat (S2b: `AgentToolGateway`'s boundary gate plus
    // `OUTSIDE_VAULT_ALLOWANCE_KEY`). "may pause" rather than "does", because
    // full trust skips every approval.
    expect(prompt).toContain("may pause for the user's approval")
    expect(prompt).toContain('grant for the rest of this chat')
    expect(prompt).toContain('a terminal cwd')
    // Narrow large shell output at the source rather than paging through it.
    expect(prompt).toContain('| head')
  })

  it('reports the Windows shell dialect when that is what commands will run under', () => {
    const prompt = buildMaxEnvironmentPrompt({
      ...facts,
      platform: 'win32',
      shell: 'powershell',
    })

    expect(prompt).toContain('Shell: powershell')
    expect(prompt).toContain('win32 (arm64)')
  })
})
