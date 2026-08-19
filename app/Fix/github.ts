/**
 * The GitHub calls "Fix with AI" needs, and nothing else.
 *
 * Deliberately hand-rolled over fetch rather than pulling in Octokit: this uses
 * six endpoints, all of them plain REST, and the dependency would be larger than
 * the file. Every call goes through {@link api}, so the auth header, the version
 * pin, the timeout and the error shape are decided once.
 *
 * Nothing here logs a token or puts one in an error message. Failures carry the
 * status and GitHub's own message, which is what a user needs to fix a bad
 * credential, and never the credential itself.
 */

const API = 'https://api.github.com'

/** GitHub rejects requests with no User-Agent. */
const UA = 'loghq (+https://loghq.org)'

const TIMEOUT_MS = 15_000

/**
 * Encode one path segment.
 *
 * Owner and repository names are validated by parseRepositoryRef before they
 * reach storage, but this file is reachable from anywhere and a segment that
 * escaped its position would change which endpoint is called, not merely fail.
 */
function seg(value: string): string {
  return encodeURIComponent(value)
}

export interface GitHubError {
  status: number
  message: string
}

export class GitHubRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'GitHubRequestError'
    this.status = status
  }
}

async function api<T>(
  token: string,
  path: string,
  init: RequestInit & { raw?: boolean } = {},
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'User-Agent': UA,
      // Pinned: unversioned requests follow whatever GitHub ships next.
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!response.ok) {
    // GitHub answers a missing repo and a token without access to it identically
    // (404), on purpose, so private repository names cannot be enumerated. The
    // message says so rather than claiming the repo does not exist.
    const body = (await response.json().catch(() => ({}))) as { message?: string }
    const message = response.status === 404
      ? 'Not found, or this token cannot see it. GitHub returns the same answer for both.'
      : body.message || `GitHub returned ${response.status}.`
    throw new GitHubRequestError(response.status, message)
  }

  return (await response.json()) as T
}

export interface RepositoryAccess {
  defaultBranch: string
  /** True when the credential can push a branch, not merely read one. */
  canWrite: boolean
  private: boolean
  fullName: string
}

/**
 * Prove the credential works against this repository, before storing it.
 *
 * Connecting without this check means the first failure surfaces minutes later,
 * inside a fix run, as "could not open a pull request" - long after the person
 * who could fix the token has moved on.
 */
export async function verifyAccess(owner: string, name: string, token: string): Promise<RepositoryAccess> {
  const repo = await api<{
    default_branch: string
    private: boolean
    full_name: string
    permissions?: { push?: boolean, maintain?: boolean, admin?: boolean }
  }>(token, `/repos/${seg(owner)}/${seg(name)}`)

  return {
    defaultBranch: repo.default_branch,
    canWrite: !!(repo.permissions?.push || repo.permissions?.maintain || repo.permissions?.admin),
    private: repo.private,
    fullName: repo.full_name,
  }
}

export interface RepositoryFile {
  path: string
  content: string
  /** Blob sha, required to update the file in a later commit. */
  sha: string
}

/**
 * One file's contents at a ref.
 *
 * Returns null for anything that is not a readable text file: a missing path, a
 * directory, or a blob too large for the contents API. The analyser asks for
 * paths a model guessed, so "not there" is an ordinary answer, not an error.
 */
export async function readFile(
  owner: string,
  name: string,
  token: string,
  path: string,
  ref?: string,
): Promise<RepositoryFile | null> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  try {
    const file = await api<{ type: string, content?: string, encoding?: string, sha: string, path: string }>(
      token,
      `/repos/${seg(owner)}/${seg(name)}/contents/${encoded}${query}`,
    )
    if (file.type !== 'file' || file.encoding !== 'base64' || !file.content)
      return null
    return {
      path: file.path,
      content: Buffer.from(file.content, 'base64').toString('utf8'),
      sha: file.sha,
    }
  }
  catch (error) {
    if (error instanceof GitHubRequestError && error.status === 404)
      return null
    throw error
  }
}

/** The commit a branch currently points at. */
export async function branchHead(owner: string, name: string, token: string, branch: string): Promise<string> {
  const ref = await api<{ object: { sha: string } }>(
    token,
    `/repos/${seg(owner)}/${seg(name)}/git/ref/heads/${encodeURIComponent(branch)}`,
  )
  return ref.object.sha
}

export async function createBranch(
  owner: string,
  name: string,
  token: string,
  branch: string,
  fromSha: string,
): Promise<void> {
  await api(token, `/repos/${seg(owner)}/${seg(name)}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
  })
}

/** Create or update one file on a branch. `sha` is required to update. */
export async function putFile(input: {
  owner: string
  name: string
  token: string
  path: string
  content: string
  message: string
  branch: string
  sha?: string
}): Promise<void> {
  const encoded = input.path.split('/').map(encodeURIComponent).join('/')
  await api(input.token, `/repos/${seg(input.owner)}/${seg(input.name)}/contents/${encoded}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: input.message,
      content: Buffer.from(input.content, 'utf8').toString('base64'),
      branch: input.branch,
      ...(input.sha ? { sha: input.sha } : {}),
    }),
  })
}

export interface PullRequest {
  number: number
  url: string
}

/**
 * Always a draft.
 *
 * A machine-authored change to someone's application should arrive as a
 * proposal. Draft is also the honest signal: the analyser reasoned from one log
 * entry and the files it named, and it did not run the test suite.
 */
export async function openDraftPullRequest(input: {
  owner: string
  name: string
  token: string
  title: string
  body: string
  head: string
  base: string
}): Promise<PullRequest> {
  const pr = await api<{ number: number, html_url: string }>(
    input.token,
    `/repos/${seg(input.owner)}/${seg(input.name)}/pulls`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: true,
      }),
    },
  )
  return { number: pr.number, url: pr.html_url }
}
