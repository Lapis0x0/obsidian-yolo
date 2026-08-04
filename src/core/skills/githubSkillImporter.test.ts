import { type RequestUrlResponse, requestUrl } from 'obsidian'

import { fetchGitHubSkill, parseGitHubUrl } from './githubSkillImporter'

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

const makeResponse = ({
  arrayBuffer = new ArrayBuffer(0),
  json = null,
  text = '',
}: {
  arrayBuffer?: ArrayBuffer
  json?: unknown
  text?: string
}): RequestUrlResponse => ({
  status: 200,
  headers: {},
  arrayBuffer,
  json,
  text,
})

describe('parseGitHubUrl', () => {
  it('parses a single-file blob URL', () => {
    expect(
      parseGitHubUrl(
        'https://github.com/user/repo/blob/main/skills/my-skill.md',
      ),
    ).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      branchExplicit: true,
      path: 'skills/my-skill.md',
      type: 'file',
    })
  })

  it('parses a repo root URL', () => {
    expect(parseGitHubUrl('https://github.com/user/repo')).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      branchExplicit: false,
      type: 'repo',
    })
  })

  it('parses repo URL with trailing slash', () => {
    expect(parseGitHubUrl('https://github.com/user/repo/')).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      branchExplicit: false,
      type: 'repo',
    })
  })

  it('parses repo URL with .git suffix', () => {
    expect(parseGitHubUrl('https://github.com/user/repo.git')).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      branchExplicit: false,
      type: 'repo',
    })
  })

  it('parses a tree URL pointing to a subdirectory', () => {
    expect(
      parseGitHubUrl(
        'https://github.com/okooo5km/beautiful-mermaid-cli/tree/main/skills/beautiful-mermaid',
      ),
    ).toEqual({
      owner: 'okooo5km',
      repo: 'beautiful-mermaid-cli',
      branch: 'main',
      branchExplicit: true,
      path: 'skills/beautiful-mermaid',
      type: 'repo',
    })
  })

  it('parses tree URL with master branch', () => {
    expect(
      parseGitHubUrl('https://github.com/user/repo/tree/master/path/to/skill'),
    ).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'master',
      branchExplicit: true,
      path: 'path/to/skill',
      type: 'repo',
    })
  })

  it('parses blob URL with master branch', () => {
    expect(
      parseGitHubUrl('https://github.com/user/repo/blob/master/skills/test.md'),
    ).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'master',
      branchExplicit: true,
      path: 'skills/test.md',
      type: 'file',
    })
  })

  it('accepts http:// scheme', () => {
    expect(parseGitHubUrl('http://github.com/user/repo')).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      branchExplicit: false,
      type: 'repo',
    })
  })

  it('trims surrounding whitespace', () => {
    expect(parseGitHubUrl('  https://github.com/user/repo  ')).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      branchExplicit: false,
      type: 'repo',
    })
  })

  it('returns null for non-GitHub URL', () => {
    expect(parseGitHubUrl('https://example.com/file.md')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseGitHubUrl('')).toBeNull()
    expect(parseGitHubUrl('   ')).toBeNull()
  })

  it('returns null for blob URL pointing to non-md file', () => {
    expect(
      parseGitHubUrl('https://github.com/user/repo/blob/main/readme.txt'),
    ).toBeNull()
  })

  it('returns null when path contains ".." segment (decoded)', () => {
    expect(
      parseGitHubUrl('https://github.com/user/repo/tree/main/skills/../etc'),
    ).toBeNull()
  })

  it('returns null when path contains percent-encoded ".."', () => {
    expect(
      parseGitHubUrl('https://github.com/user/repo/tree/main/%2e%2e/etc'),
    ).toBeNull()
  })

  it('returns null when path contains backslash', () => {
    expect(
      parseGitHubUrl('https://github.com/user/repo/blob/main/foo\\bar.md'),
    ).toBeNull()
  })

  it('returns null when owner has invalid chars', () => {
    expect(parseGitHubUrl('https://github.com/us er/repo')).toBeNull()
  })

  it('returns null for blob path that decodes to a non-md file', () => {
    // `%2e` 解码为 `.`,导致 .md 后缀消失 — 应在正则层先拒绝;
    // 但保险起见再覆盖 segment 校验路径
    expect(
      parseGitHubUrl('https://github.com/user/repo/blob/main/foo%00.md'),
    ).toBeNull()
  })

  it('returns null for URL with query string after repo', () => {
    expect(parseGitHubUrl('https://github.com/user/repo?tab=readme')).toBeNull()
  })

  it('returns null for URL with fragment after repo', () => {
    expect(parseGitHubUrl('https://github.com/user/repo#readme')).toBeNull()
  })

  it('returns null when owner is "."', () => {
    expect(parseGitHubUrl('https://github.com/./repo')).toBeNull()
  })

  it('returns null when repo is ".."', () => {
    expect(parseGitHubUrl('https://github.com/user/..')).toBeNull()
  })

  it('returns null when branch is ".."', () => {
    expect(
      parseGitHubUrl('https://github.com/user/repo/blob/../SKILL.md'),
    ).toBeNull()
    expect(
      parseGitHubUrl('https://github.com/user/repo/tree/../path'),
    ).toBeNull()
  })
})

describe('fetchGitHubSkill package resources', () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset()
  })

  it('keeps non-entry package resources as exact bytes', async () => {
    const skillContent = [
      '---',
      'name: different-frontmatter-name',
      'description: Keeps binary assets unchanged.',
      '---',
    ].join('\n')
    const skillBytes = new TextEncoder().encode(skillContent).buffer
    const assetBytes = new Uint8Array([0, 255, 1, 2]).buffer
    mockedRequestUrl
      .mockResolvedValueOnce(
        makeResponse({
          json: {
            sha: 'tree',
            truncated: false,
            tree: [
              {
                path: 'SKILL.md',
                mode: '100644',
                type: 'blob',
                sha: 'skill',
                size: skillBytes.byteLength,
              },
              {
                path: 'assets/icon.bin',
                mode: '100644',
                type: 'blob',
                sha: 'asset',
                size: assetBytes.byteLength,
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(makeResponse({ arrayBuffer: skillBytes }))
      .mockResolvedValueOnce(makeResponse({ arrayBuffer: assetBytes }))

    const [result] = await fetchGitHubSkill(
      'https://github.com/user/binary-assets',
    )

    expect(result.targetName).toBe('binary-assets')
    expect(
      result.files.find((file) => file.relativePath === 'SKILL.md'),
    ).toEqual({ relativePath: 'SKILL.md', content: skillContent })
    const asset = result.files.find(
      (file) => file.relativePath === 'assets/icon.bin',
    )
    expect(new Uint8Array(asset?.data ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array([0, 255, 1, 2]),
    )
  })

  it('preserves a blob filename instead of replacing it with frontmatter name', async () => {
    const content = ['---', 'name: different-name', '---'].join('\n')
    mockedRequestUrl.mockResolvedValueOnce(makeResponse({ text: content }))

    const [result] = await fetchGitHubSkill(
      'https://github.com/user/repo/blob/main/readable-file.md',
    )

    expect(result).toMatchObject({
      sourceName: 'readable-file.md',
      targetName: 'readable-file.md',
      isDirectory: false,
    })
  })
})
