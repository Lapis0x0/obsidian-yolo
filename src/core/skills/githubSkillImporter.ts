import { requestUrl } from 'obsidian'

import type { FileEntry } from './skillValidation'

export type GitHubUrlInfo = {
  owner: string
  repo: string
  branch: string
  path?: string
  type: 'file' | 'repo'
}

const GITHUB_BLOB_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)\/blob\/([^/]+)\/(.+\.md)$/

const GITHUB_TREE_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)\/tree\/([^/]+)\/(.+)$/

const GITHUB_REPO_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/|\.git\/?|\/?)?$/

export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) return null

  const blobMatch = GITHUB_BLOB_RE.exec(trimmed)
  if (blobMatch) {
    return {
      owner: blobMatch[1],
      repo: blobMatch[2],
      branch: blobMatch[3],
      path: blobMatch[4],
      type: 'file',
    }
  }

  const treeMatch = GITHUB_TREE_RE.exec(trimmed)
  if (treeMatch) {
    return {
      owner: treeMatch[1],
      repo: treeMatch[2],
      branch: treeMatch[3],
      path: treeMatch[4],
      type: 'repo',
    }
  }

  const repoMatch = GITHUB_REPO_RE.exec(trimmed)
  if (repoMatch) {
    const cleanRepo = repoMatch[2].replace(/\.git$/, '')
    return {
      owner: repoMatch[1],
      repo: cleanRepo,
      branch: 'main',
      type: 'repo',
    }
  }

  return null
}

function buildRawUrl(info: GitHubUrlInfo, filePath?: string): string {
  const path = filePath ?? info.path
  if (!path) {
    throw new Error('File path is required for raw URL construction')
  }
  return `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${info.branch}/${path}`
}

async function fetchRaw(rawUrl: string): Promise<string> {
  const response = await requestUrl({ url: rawUrl })
  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status}: ${rawUrl}`)
  }
  return response.text
}

async function fetchRepoFile(
  info: GitHubUrlInfo,
  filePath: string,
): Promise<string | null> {
  try {
    return await fetchRaw(buildRawUrl(info, filePath))
  } catch {
    return null
  }
}

export type GitHubFetchResult = {
  files: FileEntry[]
  sourceName: string
  targetName: string
  description: string
  isDirectory: boolean
}

type GitHubContentEntry = {
  name: string
  path: string
  download_url: string | null
  type: 'file' | 'dir'
}

async function fetchDirectoryEntries(
  apiUrl: string,
  files: FileEntry[],
  info: GitHubUrlInfo,
  prefix = '',
): Promise<void> {
  let listing: GitHubContentEntry[]
  try {
    const response = await requestUrl({ url: apiUrl })
    if (response.status !== 200 || !Array.isArray(response.json)) return
    listing = response.json
  } catch {
    return
  }

  for (const entry of listing) {
    if (!prefix && entry.name === 'SKILL.md') continue

    if (entry.type === 'file' && entry.download_url) {
      try {
        const content = await fetchRaw(entry.download_url)
        files.push({ relativePath: prefix + entry.name, content })
      } catch {
        // skip files that fail to fetch
      }
    } else if (entry.type === 'dir') {
      const subApiUrl = `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${entry.path}`
      await fetchDirectoryEntries(
        subApiUrl,
        files,
        info,
        prefix + entry.name + '/',
      )
    }
  }
}

export async function fetchGitHubSkill(
  url: string,
): Promise<GitHubFetchResult> {
  const info = parseGitHubUrl(url)
  if (!info) {
    throw new Error('Invalid GitHub URL')
  }

  if (info.type === 'file') {
    const content = await fetchRaw(buildRawUrl(info))
    const fileName = info.path!.split('/').pop()!
    return {
      files: [{ relativePath: fileName, content }],
      sourceName: fileName,
      targetName: fileName,
      description: '',
      isDirectory: false,
    }
  }

  // Repo mode: check for SKILL.md in directory (subpath or root)
  const dirPath = info.path ?? ''
  const skillMdPath = dirPath ? `${dirPath}/SKILL.md` : 'SKILL.md'
  let skillMd = await fetchRepoFile(info, skillMdPath)
  if (!skillMd && info.branch === 'main') {
    skillMd = await fetchRepoFile({ ...info, branch: 'master' }, skillMdPath)
  }
  if (!skillMd) {
    throw new Error(
      'No SKILL.md found at the specified path — not a valid skill package',
    )
  }

  // Fetch directory listing via GitHub API (public only)
  const files: FileEntry[] = [{ relativePath: 'SKILL.md', content: skillMd }]
  const apiBase = `https://api.github.com/repos/${info.owner}/${info.repo}/contents`
  const apiDir = dirPath ? `${apiBase}/${dirPath}` : apiBase

  await fetchDirectoryEntries(apiDir, files, info)

  // Derive targetName from frontmatter name
  const fmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/)
  let targetName = info.repo
  if (fmMatch) {
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m)
    if (nameMatch) {
      targetName = nameMatch[1].trim()
    }
  }

  const descMatch = skillMd.match(/^description:\s*(.+)$/m)
  const description = descMatch ? descMatch[1].trim() : ''

  return {
    files,
    sourceName: info.repo,
    targetName,
    description,
    isDirectory: true,
  }
}
