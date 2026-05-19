import { parseGitHubUrl } from '../../../core/skills/githubSkillImporter'

describe('parseGitHubUrl', () => {
  it('parses a single-file blob URL', () => {
    const result = parseGitHubUrl(
      'https://github.com/user/repo/blob/main/skills/my-skill.md',
    )
    expect(result).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      path: 'skills/my-skill.md',
      type: 'file',
    })
  })

  it('parses a repo root URL', () => {
    const result = parseGitHubUrl('https://github.com/user/repo')
    expect(result).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      type: 'repo',
    })
  })

  it('parses repo URL with trailing slash', () => {
    const result = parseGitHubUrl('https://github.com/user/repo/')
    expect(result).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      type: 'repo',
    })
  })

  it('parses repo URL with .git suffix', () => {
    const result = parseGitHubUrl('https://github.com/user/repo.git')
    expect(result).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      type: 'repo',
    })
  })

  it('returns null for non-GitHub URL', () => {
    expect(parseGitHubUrl('https://example.com/file.md')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseGitHubUrl('')).toBeNull()
  })

  it('returns null for non-md file URL', () => {
    expect(
      parseGitHubUrl('https://github.com/user/repo/blob/main/readme.txt'),
    ).toBeNull()
  })

  it('parses URL with master branch', () => {
    const result = parseGitHubUrl(
      'https://github.com/user/repo/blob/master/skills/test.md',
    )
    expect(result).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'master',
      path: 'skills/test.md',
      type: 'file',
    })
  })

  it('handles http:// scheme', () => {
    const result = parseGitHubUrl('http://github.com/user/repo')
    expect(result).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      type: 'repo',
    })
  })

  it('parses a tree URL pointing to a subdirectory', () => {
    const result = parseGitHubUrl(
      'https://github.com/okooo5km/beautiful-mermaid-cli/tree/main/skills/beautiful-mermaid',
    )
    expect(result).toEqual({
      owner: 'okooo5km',
      repo: 'beautiful-mermaid-cli',
      branch: 'main',
      path: 'skills/beautiful-mermaid',
      type: 'repo',
    })
  })

  it('parses a tree URL with master branch', () => {
    const result = parseGitHubUrl(
      'https://github.com/user/repo/tree/master/path/to/skill',
    )
    expect(result).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'master',
      path: 'path/to/skill',
      type: 'repo',
    })
  })
})
