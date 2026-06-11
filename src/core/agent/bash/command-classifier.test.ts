import { classifyBashCommandSafety } from './command-classifier'

describe('classifyBashCommandSafety', () => {
  it('allows POSIX read-only pipelines', () => {
    expect(
      classifyBashCommandSafety('git status --short | head -20', 'posix')
        .readonly,
    ).toBe(true)
    expect(
      classifyBashCommandSafety('rg "hello" src | wc -l', 'posix').readonly,
    ).toBe(true)
  })

  it('requires approval for POSIX writes and unsafe subcommands', () => {
    expect(
      classifyBashCommandSafety('echo hello > out.txt', 'posix').readonly,
    ).toBe(false)
    expect(
      classifyBashCommandSafety('git checkout main', 'posix').readonly,
    ).toBe(false)
    expect(
      classifyBashCommandSafety('find . -name "*.tmp" -delete', 'posix')
        .readonly,
    ).toBe(false)
  })

  it('allows PowerShell read-only commands', () => {
    expect(
      classifyBashCommandSafety(
        'Get-ChildItem src | Select-String hello',
        'powershell',
      ).readonly,
    ).toBe(true)
  })

  it('requires approval for uncertain syntax', () => {
    expect(classifyBashCommandSafety('cat $(rm file)', 'posix').readonly).toBe(
      false,
    )
    expect(classifyBashCommandSafety('cat <<EOF', 'posix').readonly).toBe(false)
    expect(
      classifyBashCommandSafety('cat file\nrm file', 'posix').readonly,
    ).toBe(false)
  })
})
