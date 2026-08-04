import { requestUrl } from 'obsidian'

import { type FileEntry } from './skillValidation'

// ---------------------------------------------------------------------------
// 唯一保留的边界:单文件大小。其它(深度 / 文件数 / 目录数)由 GitHub 自身的
// Trees API 限制(单次响应最多 10 万条 / 7MB,返回 truncated:true)兜底。
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 1 * 1024 * 1024 // 单个文件 1MB

// owner / repo / 分支 / 路径 segment 字符集白名单
// GitHub 限制 owner / repo 仅含 alnum / `-` / `_` / `.`,这里复用
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/

function isSafePathSegment(seg: string): boolean {
  if (!seg) return false
  if (seg === '.' || seg === '..') return false
  if (/[\\]/.test(seg)) return false
  // 拒绝控制字符 / 文件系统危险字符
  // eslint-disable-next-line no-control-regex -- 显式检查 NUL 与控制字符,正是这里的目的
  if (/[<>:"|?*\x00-\x1f]/.test(seg)) return false
  return true
}

function decodeAndValidatePath(path: string): string | null {
  if (/\\/.test(path)) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }
  // eslint-disable-next-line no-control-regex -- 显式检查控制字符
  if (/\\/.test(decoded) || /[\x00-\x1f]/.test(decoded)) return null
  const segments = decoded.split('/')
  for (const seg of segments) {
    if (!isSafePathSegment(seg)) return null
  }
  return decoded
}

// ---------------------------------------------------------------------------
// URL 解析
// ---------------------------------------------------------------------------

export type GitHubUrlInfo = {
  owner: string
  repo: string
  /** 显式分支(URL 里写了的);裸仓库 URL 推断为 'main',允许 fallback 到 'master' */
  branch: string
  /** branch 是否来自 URL 显式指定;影响 master fallback 行为 */
  branchExplicit: boolean
  /** 文件路径(file 模式) / 子目录路径(repo 模式,可选) */
  path?: string
  type: 'file' | 'repo'
}

const GITHUB_BLOB_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)\/blob\/([^/]+)\/(.+\.md)$/

const GITHUB_TREE_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)\/tree\/([^/]+)\/(.+)$/

const GITHUB_REPO_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/

function isSafeSegment(seg: string): boolean {
  if (!seg) return false
  if (seg === '.' || seg === '..') return false
  return SEGMENT_PATTERN.test(seg)
}

function validateOwnerRepo(owner: string, repo: string): boolean {
  return isSafeSegment(owner) && isSafeSegment(repo)
}

export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) return null

  const blobMatch = GITHUB_BLOB_RE.exec(trimmed)
  if (blobMatch) {
    const owner = blobMatch[1]
    const repo = blobMatch[2]
    const branch = blobMatch[3]
    if (!validateOwnerRepo(owner, repo)) return null
    if (!isSafeSegment(branch)) return null
    const safePath = decodeAndValidatePath(blobMatch[4])
    if (!safePath) return null
    return {
      owner,
      repo,
      branch,
      branchExplicit: true,
      path: safePath,
      type: 'file',
    }
  }

  const treeMatch = GITHUB_TREE_RE.exec(trimmed)
  if (treeMatch) {
    const owner = treeMatch[1]
    const repo = treeMatch[2]
    const branch = treeMatch[3]
    if (!validateOwnerRepo(owner, repo)) return null
    if (!isSafeSegment(branch)) return null
    const safePath = decodeAndValidatePath(treeMatch[4])
    if (!safePath) return null
    return {
      owner,
      repo,
      branch,
      branchExplicit: true,
      path: safePath,
      type: 'repo',
    }
  }

  const repoMatch = GITHUB_REPO_RE.exec(trimmed)
  if (repoMatch) {
    const owner = repoMatch[1]
    const repo = repoMatch[2]
    if (!validateOwnerRepo(owner, repo)) return null
    return {
      owner,
      repo,
      branch: 'main',
      branchExplicit: false,
      type: 'repo',
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

export class GitHubRateLimitError extends Error {
  constructor() {
    super('GitHub API rate limit exceeded')
    this.name = 'GitHubRateLimitError'
  }
}

export class GitHubNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubNotFoundError'
  }
}

export class GitHubLimitExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubLimitExceededError'
  }
}

// ---------------------------------------------------------------------------
// 底层 HTTP
// ---------------------------------------------------------------------------

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

function buildRawUrl(info: GitHubUrlInfo, filePath: string): string {
  return `https://raw.githubusercontent.com/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/${encodeURIComponent(info.branch)}/${encodePathSegments(filePath)}`
}

function isRateLimitResponse(
  status: number,
  headers: Record<string, string> | undefined,
): boolean {
  if (status === 429) return true
  if (status !== 403) return false
  // primary:x-ratelimit-remaining: 0
  const remaining =
    headers?.['x-ratelimit-remaining'] ?? headers?.['X-RateLimit-Remaining']
  if (remaining === '0') return true
  // secondary:retry-after 头存在(GitHub 在 secondary rate limit 下会带 retry-after)
  if (headers?.['retry-after'] ?? headers?.['Retry-After']) return true
  return false
}

/**
 * 抓取 raw 文本,带大小上限。content-length 优先;没有时下载完成后用 byte length 复核。
 */
async function fetchRawText(rawUrl: string): Promise<string> {
  const response = await requestUrl({ url: rawUrl, throw: false })

  if (isRateLimitResponse(response.status, response.headers)) {
    throw new GitHubRateLimitError()
  }
  if (response.status === 404) {
    throw new GitHubNotFoundError(`404: ${rawUrl}`)
  }
  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status}: ${rawUrl}`)
  }

  const contentLengthRaw =
    response.headers?.['content-length'] ?? response.headers?.['Content-Length']
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : NaN
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
    throw new GitHubLimitExceededError(
      `file exceeds ${MAX_FILE_BYTES} bytes: ${rawUrl}`,
    )
  }

  const text = response.text
  // CDN 可能 gzip,content-length 比解压后小;下载完成后再用 UTF-8 字节复核
  const byteLength = new TextEncoder().encode(text).byteLength
  if (byteLength > MAX_FILE_BYTES) {
    throw new GitHubLimitExceededError(
      `file exceeds ${MAX_FILE_BYTES} bytes: ${rawUrl}`,
    )
  }
  return text
}

/** Fetch package resources as exact bytes so binary assets are never decoded. */
async function fetchRawBytes(rawUrl: string): Promise<ArrayBuffer> {
  const response = await requestUrl({ url: rawUrl, throw: false })

  if (isRateLimitResponse(response.status, response.headers)) {
    throw new GitHubRateLimitError()
  }
  if (response.status === 404) {
    throw new GitHubNotFoundError(`404: ${rawUrl}`)
  }
  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status}: ${rawUrl}`)
  }

  const contentLengthRaw =
    response.headers?.['content-length'] ?? response.headers?.['Content-Length']
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : NaN
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
    throw new GitHubLimitExceededError(
      `file exceeds ${MAX_FILE_BYTES} bytes: ${rawUrl}`,
    )
  }

  if (response.arrayBuffer.byteLength > MAX_FILE_BYTES) {
    throw new GitHubLimitExceededError(
      `file exceeds ${MAX_FILE_BYTES} bytes: ${rawUrl}`,
    )
  }
  return response.arrayBuffer.slice(0)
}

// ---------------------------------------------------------------------------
// Git Trees API:一次请求拿整棵树,后续 raw 下载不消耗 API 配额
// ---------------------------------------------------------------------------

type GitTreeEntry = {
  path: string
  /** 100644=file, 100755=executable, 120000=symlink, 040000=dir, 160000=submodule */
  mode: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  size?: number
}

type GitTreeResponse = {
  sha: string
  tree: GitTreeEntry[]
  truncated: boolean
}

async function fetchRepoTree(info: GitHubUrlInfo): Promise<GitTreeResponse> {
  const ownerSeg = encodeURIComponent(info.owner)
  const repoSeg = encodeURIComponent(info.repo)
  const refSeg = encodeURIComponent(info.branch)
  const apiUrl = `https://api.github.com/repos/${ownerSeg}/${repoSeg}/git/trees/${refSeg}?recursive=1`

  const response = await requestUrl({ url: apiUrl, throw: false })

  if (isRateLimitResponse(response.status, response.headers)) {
    throw new GitHubRateLimitError()
  }
  if (response.status === 403) {
    throw new Error(`HTTP 403: ${apiUrl}`)
  }
  if (response.status === 404 || response.status === 422) {
    // 422 = ref 不存在(GitHub Trees API 对未知 ref 返回 422)
    throw new GitHubNotFoundError(`ref not found: ${info.branch}`)
  }
  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status}: ${apiUrl}`)
  }
  const body = response.json as GitTreeResponse | null
  if (!body || !Array.isArray(body.tree)) {
    throw new Error(`Unexpected GitHub API response: ${apiUrl}`)
  }
  return body
}

// ---------------------------------------------------------------------------
// 并发下载工具
// ---------------------------------------------------------------------------

const RAW_DOWNLOAD_CONCURRENCY = 8

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      results[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// 公共入口
// ---------------------------------------------------------------------------

export type GitHubFetchResult = {
  files: FileEntry[]
  /** 显示用源名 */
  sourceName: string
  /** 保留远端来源的文件名或目录名 */
  targetName: string
  isDirectory: boolean
}

/**
 * 从 tree 中根据 SKILL.md 入口构造一个 skill 包(下载所有 blob)。
 * skillDir = '' 表示 skill 根就是仓库根。
 */
async function buildSkillPackage(
  effectiveInfo: GitHubUrlInfo,
  tree: GitTreeResponse,
  skillDir: string,
  /** 同一棵 tree 里其它 skill 的目录,用于在嵌套时排除子树 */
  siblingSkillDirs: string[],
  fallbackRepoName: string,
): Promise<GitHubFetchResult> {
  const skillMdPath = skillDir ? `${skillDir}/SKILL.md` : 'SKILL.md'
  const subtreePrefix = skillDir ? `${skillDir}/` : ''

  const blobs = tree.tree.filter((e) => {
    if (e.type !== 'blob') return false
    if (e.mode === '120000') return false
    // 在 skill 子树内
    if (skillDir === '') {
      // 仓库根作为 skill 根:排除属于其它 skill 子树的文件
      const inOtherSkill = siblingSkillDirs.some(
        (other) => other !== '' && e.path.startsWith(`${other}/`),
      )
      return !inOtherSkill
    }
    return e.path === skillMdPath || e.path.startsWith(subtreePrefix)
  })

  // 提前用 tree 元数据拦截超大文件,省一次下载
  for (const blob of blobs) {
    if (typeof blob.size === 'number' && blob.size > MAX_FILE_BYTES) {
      throw new GitHubLimitExceededError(
        `file exceeds ${MAX_FILE_BYTES} bytes: ${blob.path}`,
      )
    }
  }

  const downloaded = await mapWithConcurrency(
    blobs,
    RAW_DOWNLOAD_CONCURRENCY,
    async (blob) => ({
      blob,
      data: await fetchRawBytes(buildRawUrl(effectiveInfo, blob.path)),
    }),
  )

  const files: FileEntry[] = []
  for (const { blob, data } of downloaded) {
    const relativePath = skillDir
      ? blob.path.slice(subtreePrefix.length)
      : blob.path
    if (blob.path === skillMdPath) {
      files.push({ relativePath, content: new TextDecoder().decode(data) })
    } else {
      files.push({ relativePath, data })
    }
  }

  const dirLastSeg = skillDir ? (skillDir.split('/').pop() ?? skillDir) : ''
  const fallbackName = dirLastSeg || fallbackRepoName

  return {
    files,
    sourceName: dirLastSeg || fallbackRepoName,
    targetName: fallbackName,
    isDirectory: true,
  }
}

/**
 * 抓取 GitHub URL 指向的内容,返回一个或多个 skill 包。
 *
 * - blob URL → 单文件 skill(返回 1 个)
 * - tree/repo URL,路径下直接有 SKILL.md → 单 skill(返回 1 个)
 * - tree/repo URL,路径下无 SKILL.md 但子树里有 N 个 → N 个 skill
 * - 找不到任何 SKILL.md → 抛 GitHubNotFoundError
 */
export async function fetchGitHubSkill(
  url: string,
): Promise<GitHubFetchResult[]> {
  const info = parseGitHubUrl(url)
  if (!info) {
    throw new Error('Invalid GitHub URL')
  }

  if (info.type === 'file') {
    const filePath = info.path!
    const content = await fetchRawText(buildRawUrl(info, filePath))
    const fileName = filePath.split('/').pop() ?? filePath
    return [
      {
        files: [{ relativePath: fileName, content }],
        sourceName: fileName,
        targetName: fileName,
        isDirectory: false,
      },
    ]
  }

  // ---- repo / tree 模式 ----
  const rootPath = info.path ?? ''

  // 1. 拿整棵 tree(允许裸仓库 URL 时 main → master fallback)
  let tree: GitTreeResponse
  let effectiveInfo = info
  try {
    tree = await fetchRepoTree(info)
  } catch (err) {
    if (
      err instanceof GitHubNotFoundError &&
      !info.branchExplicit &&
      info.branch === 'main'
    ) {
      effectiveInfo = { ...info, branch: 'master' }
      tree = await fetchRepoTree(effectiveInfo)
    } else {
      throw err
    }
  }

  if (tree.truncated) {
    throw new GitHubLimitExceededError(
      'repository tree exceeds GitHub single-response limit (truncated)',
    )
  }

  // 2. 定位所有 SKILL.md
  //    - 路径下直接有 SKILL.md:就是单 skill,以该路径为根
  //    - 否则:在该路径子树里找所有 SKILL.md
  const directSkillMd = rootPath ? `${rootPath}/SKILL.md` : 'SKILL.md'
  const hasDirectSkillMd = tree.tree.some(
    (e) => e.type === 'blob' && e.path === directSkillMd,
  )

  let skillDirs: string[]
  if (hasDirectSkillMd) {
    skillDirs = [rootPath]
  } else {
    const subtreePrefix = rootPath ? `${rootPath}/` : ''
    const skillMdEntries = tree.tree.filter((e) => {
      if (e.type !== 'blob') return false
      if (rootPath !== '' && !e.path.startsWith(subtreePrefix)) return false
      const segs = e.path.split('/')
      return segs[segs.length - 1] === 'SKILL.md'
    })
    if (skillMdEntries.length === 0) {
      throw new GitHubNotFoundError('SKILL.md not found at the specified path')
    }
    // 取每个 SKILL.md 的所在目录
    const dirs = skillMdEntries.map((e) => {
      const slashIdx = e.path.lastIndexOf('/')
      return slashIdx === -1 ? '' : e.path.slice(0, slashIdx)
    })
    // 排除嵌套:若 A 是 B 的父目录,则丢弃 B(只保留最浅的)
    dirs.sort((a, b) => a.length - b.length)
    const accepted: string[] = []
    for (const dir of dirs) {
      const isNested = accepted.some((parent) =>
        parent === '' ? true : dir.startsWith(`${parent}/`),
      )
      if (!isNested) accepted.push(dir)
    }
    skillDirs = accepted
  }

  // 3. 依次构建每个 skill 包(包内文件并发下载;skill 之间串行,避免并发爆炸)
  const results: GitHubFetchResult[] = []
  for (const skillDir of skillDirs) {
    const pkg = await buildSkillPackage(
      effectiveInfo,
      tree,
      skillDir,
      skillDirs,
      info.repo,
    )
    results.push(pkg)
  }
  return results
}
