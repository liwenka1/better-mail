import { validateReleaseVersion } from './release-targets.mjs'

const pageSize = 100
const maxPages = 10
const shaPattern = /^[a-f0-9]{40}$/

function escapeText(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\\`*_{}[\]()#+.!|~@-]/g, '\\$&')
}

function checkCommit(entry) {
  if (
    !shaPattern.test(entry?.sha || '') ||
    typeof entry.commit?.message !== 'string' ||
    !Array.isArray(entry.parents)
  )
    throw new Error('Release notes received invalid commit metadata.')
  return entry
}

async function listPages(request, url) {
  const result = []
  for (let page = 1; page <= maxPages + 1; page++) {
    const entries = await request(
      `${url}${url.includes('?') ? '&' : '?'}per_page=${pageSize}&page=${page}`
    )
    if (!Array.isArray(entries) || entries.length > pageSize)
      throw new Error('Release notes received an invalid paginated response.')
    if (result.length + entries.length > pageSize * maxPages)
      throw new Error('Release notes exceed the pagination limit; no release was published.')
    result.push(...entries)
    if (entries.length < pageSize) return result
  }
  throw new Error('Release notes exceed the pagination limit; no release was published.')
}

function checkComparison(comparison, base, expectedTotal) {
  if (
    !['ahead', 'identical'].includes(comparison?.status) ||
    !shaPattern.test(comparison.base_commit?.sha || '') ||
    comparison.merge_base_commit?.sha !== comparison.base_commit.sha ||
    (base && comparison.base_commit.sha !== base) ||
    !Number.isSafeInteger(comparison.total_commits) ||
    comparison.total_commits < 0 ||
    (comparison.status === 'identical') !== (comparison.total_commits === 0) ||
    (expectedTotal !== undefined && comparison.total_commits !== expectedTotal) ||
    !Array.isArray(comparison.commits)
  )
    throw new Error('Release notes comparison does not describe a consistent ancestor range.')
}

async function comparedCommits(request, api, commit, first) {
  checkComparison(first)
  const total = first.total_commits
  if (total > pageSize * maxPages)
    throw new Error('Release notes exceed the commit limit; no release was published.')
  const base = first.base_commit.sha
  const entries = []
  let response = first
  for (let page = 1; page <= Math.max(1, Math.ceil(total / pageSize)); page++) {
    if (page > 1)
      response = await request(
        `${api}/compare/${base}...${commit}?per_page=${pageSize}&page=${page}`
      )
    checkComparison(response, base, total)
    if (response.commits.length !== Math.min(pageSize, total - entries.length))
      throw new Error('Release notes comparison was truncated; no release was published.')
    entries.push(...response.commits.map(checkCommit))
  }
  return entries
}

function changeSections(commits, repository) {
  const sections = new Map([
    ['breaking', ['不兼容变更', []]],
    ['feat', ['新增功能', []]],
    ['fix', ['问题修复', []]],
    ['perf', ['性能改进', []]],
    ['docs', ['文档更新', []]],
    ['maintenance', ['维护与构建', []]],
    ['other', ['其他变更', []]]
  ])
  const seen = new Set()
  for (const entry of commits) {
    checkCommit(entry)
    if (seen.has(entry.sha)) throw new Error('Release notes contain duplicate commits.')
    seen.add(entry.sha)
    if (entry.parents.length > 1) continue
    const subject = entry.commit.message.split(/\r?\n/, 1)[0].trim()
    if (
      /^chore\(release\):/.test(subject) ||
      /^(?:发布\s+)?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(subject)
    )
      continue
    const conventional = subject.match(/^([a-z]+)(?:\(([^()]+)\))?(!)?:\s+(.+)$/)
    const type = conventional?.[1]
    const breaking =
      conventional?.[3] || /(?:^|\n)BREAKING[ -]CHANGE:\s*\S/.test(entry.commit.message)
    const group = breaking
      ? 'breaking'
      : sections.has(type)
        ? type
        : ['refactor', 'ci', 'build', 'test', 'chore', 'style'].includes(type)
          ? 'maintenance'
          : 'other'
    const title = conventional
      ? `${conventional[2] ? `[${conventional[2]}] ` : ''}${conventional[4]}`
      : subject
    if (!title) throw new Error('Release notes encountered an empty commit subject.')
    sections
      .get(group)[1]
      .push(
        `- ${escapeText(title)} ([${entry.sha.slice(0, 7)}](https://github.com/${repository}/commit/${entry.sha}))`
      )
  }
  const rendered = [...sections.values()]
    .filter(([, lines]) => lines.length)
    .map(([heading, lines]) => `### ${heading}\n\n${lines.join('\n')}`)
  return rendered.length ? rendered.join('\n\n') : '本次仅更新版本与发布信息。'
}

export async function releaseNotes({ request, api, repository, commit, tag, version }) {
  validateReleaseVersion(version)
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository || '') ||
    api !== `https://api.github.com/repos/${repository}` ||
    !shaPattern.test(commit || '') ||
    tag !== `v${version}`
  )
    throw new Error('Release notes require a fixed repository, version and commit.')
  const releases = await listPages(request, `${api}/releases`)
  const candidates = releases
    .filter(
      (release) => release.draft === false && release.published_at && release.tag_name !== tag
    )
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
  let previous
  for (const release of candidates) {
    if (typeof release.tag_name !== 'string' || !Number.isFinite(Date.parse(release.published_at)))
      throw new Error('Release notes received invalid published release metadata.')
    const comparison = await request(
      `${api}/compare/${encodeURIComponent(release.tag_name)}...${commit}?per_page=${pageSize}&page=1`
    )
    if (!['ahead', 'identical'].includes(comparison?.status)) continue
    checkComparison(comparison)
    if (!previous || comparison.total_commits < previous.comparison.total_commits)
      previous = { release, comparison }
  }
  if (candidates.length && !previous)
    throw new Error(
      'No published release is an ancestor of this commit; release history needs review.'
    )
  const commits = previous
    ? await comparedCommits(request, api, commit, previous.comparison)
    : (await listPages(request, `${api}/commits?sha=${commit}`)).map(checkCommit)
  if (!previous && !commits.length)
    throw new Error('Release notes received an empty history for the release commit.')
  const comparison = previous
    ? `[${escapeText(previous.release.tag_name)} → ${escapeText(tag)}](https://github.com/${repository}/compare/${previous.comparison.base_commit.sha}...${commit})`
    : `[首次发布提交](https://github.com/${repository}/commit/${commit})`
  const notes =
    `## 本次变更\n\n${changeSections(commits, repository)}\n\n${comparison}\n\n` +
    `## 安装包\n\n所有平台均通过独立构建与原生 SQLite ABI 检查后发布。\n\n` +
    `- macOS：Apple Silicon（arm64）与 Intel（x64），提供 DMG 和 ZIP。\n` +
    `- Windows：x64 安装程序。\n` +
    `- Linux：x64 AppImage 与 Debian 安装包。\n\n` +
    `此版本尚未配置应用代码签名和 macOS 公证，系统可能显示发布者验证提示。\n` +
    `请使用 SHA256SUMS.txt 核对安装包；各依赖声明包含在应用的 THIRD_PARTY_NOTICES.md 中。`
  if (notes.length > 60_000)
    throw new Error('Release notes exceed the body limit; no release was published.')
  return notes
}
