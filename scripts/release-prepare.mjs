import { appendFile } from 'node:fs/promises'
import { compareReleaseVersions, validateReleaseVersion } from './release-targets.mjs'

if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
  process.env.GITHUB_REF !== 'refs/heads/main'
)
  throw new Error('Run manual releases from the main branch in GitHub Actions.')

const version = validateReleaseVersion((process.env.RELEASE_VERSION || '').trim().replace(/^v/, ''))
const tag = `v${version}`
const repository = process.env.GITHUB_REPOSITORY
const source = process.env.GITHUB_SHA
const token = process.env.GH_TOKEN
const email = process.env.RELEASE_COMMIT_EMAIL
const actor = process.env.GITHUB_ACTOR
if (
  !/^[\w.-]+\/[\w.-]+$/.test(repository || '') ||
  !/^[a-f0-9]{40}$/.test(source || '') ||
  !token ||
  !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email || '') ||
  !/^[\w[\]-]+$/.test(actor || '') ||
  !process.env.GITHUB_OUTPUT
)
  throw new Error('Manual release repository, source, identity or output is missing.')

const api = `https://api.github.com/repos/${repository}`
async function request(path, method = 'GET', body, allowMissing = false) {
  const response = await fetch(api + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(60_000)
  })
  if (allowMissing && response.status === 404) return null
  if (!response.ok) throw new Error(`Release preparation API failed: HTTP ${response.status}`)
  return response.json()
}
async function packageAt(commit) {
  const file = await request(`/contents/package.json?ref=${commit}`)
  if (file.type !== 'file' || file.encoding !== 'base64')
    throw new Error('Cannot read package.json from the release source.')
  const text = Buffer.from(file.content, 'base64').toString('utf8')
  const metadata = JSON.parse(text)
  validateReleaseVersion(metadata.version)
  return { text, metadata }
}
async function commitReference(reference) {
  for (let depth = 0; reference?.type === 'tag' && depth < 4; depth++)
    reference = (await request(`/git/tags/${reference.sha}`)).object
  if (reference?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(reference.sha || ''))
    throw new Error('The release reference must resolve to a commit.')
  return reference.sha
}

const existing = await request(`/releases/tags/${tag}`, 'GET', undefined, true)
if (existing && !existing.draft)
  throw new Error(
    `${tag} is already public. Choose a new version; published assets cannot be replaced.`
  )

const main = await request('/git/ref/heads/main')
const mainCommit = await commitReference(main.object)
const tagged = await request(`/git/ref/tags/${tag}`, 'GET', undefined, true)
const original = await packageAt(source)
if (compareReleaseVersions(version, original.metadata.version) < 0)
  throw new Error('The release version must not be older than the selected main source.')

let commit
if (tagged) {
  // An interrupted release keeps its source, even if main gained later commits.
  commit = await commitReference(tagged.object)
  if ((await packageAt(commit)).metadata.version !== version)
    throw new Error('The existing tag has a different package version; tags are never overwritten.')
  const mainPackage = mainCommit === source ? original : await packageAt(mainCommit)
  if (compareReleaseVersions(version, mainPackage.metadata.version) < 0)
    throw new Error(
      'A newer version is already on main. Use Re-run failed jobs on the original run instead.'
    )
  if (commit !== mainCommit) {
    const comparison = await request(`/compare/${commit}...${mainCommit}`)
    if (!['ahead', 'identical'].includes(comparison.status))
      throw new Error('The existing release tag is not in main history; refusing to reuse it.')
  }
} else {
  const text = JSON.stringify({ ...original.metadata, version }, null, 2) + '\n'
  if (mainCommit !== source) {
    // Recover a rerun interrupted after the version commit but before tag creation.
    const current = await packageAt(mainCommit)
    const comparison = await request(`/compare/${source}...${mainCommit}`)
    if (
      current.text !== text ||
      comparison.status !== 'ahead' ||
      comparison.total_commits !== 1 ||
      comparison.files?.length !== 1 ||
      comparison.files[0].filename !== 'package.json'
    )
      throw new Error('main changed after this run started. Start a new manual release from main.')
    commit = mainCommit
  } else if (original.metadata.version === version) {
    commit = source
  } else {
    const base = await request(`/git/commits/${source}`)
    const blob = await request('/git/blobs', 'POST', {
      content: Buffer.from(text).toString('base64'),
      encoding: 'base64'
    })
    const tree = await request('/git/trees', 'POST', {
      base_tree: base.tree.sha,
      tree: [{ path: 'package.json', mode: '100644', type: 'blob', sha: blob.sha }]
    })
    const identity = { name: actor, email }
    const prepared = await request('/git/commits', 'POST', {
      message: `chore(release): 发布 ${tag}`,
      tree: tree.sha,
      parents: [source],
      author: identity,
      committer: identity
    })
    commit = prepared.sha
    const updated = await request('/git/refs/heads/main', 'PATCH', { sha: commit, force: false })
    if (updated.object.sha !== commit)
      throw new Error('The version commit was not applied to main.')
  }
  await request('/git/refs', 'POST', { ref: `refs/tags/${tag}`, sha: commit })
}

const confirmed = await request(`/git/ref/tags/${tag}`)
if ((await commitReference(confirmed.object)) !== commit)
  throw new Error('The remote tag does not match the prepared release commit.')
await appendFile(process.env.GITHUB_OUTPUT, `commit=${commit}\ntag=${tag}\nversion=${version}\n`)
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `### 发布 ${tag}\n\n` +
      `| 项目 | 内容 |\n| --- | --- |\n` +
      `| 源版本 | ${original.metadata.version} |\n` +
      `| 目标版本 | ${version} |\n` +
      `| 源提交 | [${source.slice(0, 7)}](https://github.com/${repository}/commit/${source}) |\n` +
      `| 版本提交 | [${commit.slice(0, 7)}](https://github.com/${repository}/commit/${commit}) |\n` +
      `| 平台 | macOS arm64 / x64、Windows x64、Linux x64 |\n\n` +
      `四个平台将从版本提交构建，全部校验成功后公开 [${tag} 的下载页](https://github.com/${repository}/releases/tag/${tag})。\n`
  )
console.log(`Prepared ${tag} at ${commit}`)
