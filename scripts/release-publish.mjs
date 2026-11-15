import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artifactNames, releaseVersion } from './release-targets.mjs'

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_REF?.startsWith('refs/tags/'))
  throw new Error('Publish releases only from the successful tag workflow.')
const version = await releaseVersion()
const tag = `v${version}`
const repository = process.env.GITHUB_REPOSITORY
const commit = process.env.GITHUB_SHA
const token = process.env.GH_TOKEN
if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^[a-f0-9]{40}$/.test(commit || '') || !token)
  throw new Error('Release repository, commit or token is missing.')
const api = `https://api.github.com/repos/${repository}`
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2026-03-10'
}
async function request(url, options = {}, allowMissing = false) {
  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(10 * 60_000)
  })
  if (allowMissing && response.status === 404) return null
  if (!response.ok) throw new Error(`Release API request failed: HTTP ${response.status}`)
  return response.status === 204 ? null : response.json()
}
async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

// Only a complete set from this run can become a public release.
const directory = 'release/download'
const names = artifactNames(version)
const received = await readdir(directory)
if (received.length !== names.length || received.some((name) => !names.includes(name)))
  throw new Error('The release requires exactly the installers from all four platform builds.')
const hashes = new Map()
for (const name of names) {
  const file = join(directory, name)
  const info = await lstat(file)
  if (!info.isFile() || info.size < 1024) throw new Error(`Invalid release installer: ${name}`)
  hashes.set(name, { hash: await hashFile(file), size: info.size })
}
const checksums = 'SHA256SUMS.txt'
await writeFile(
  join(directory, checksums),
  names.map((name) => `${hashes.get(name).hash}  ${name}\n`).join('')
)
hashes.set(checksums, {
  hash: await hashFile(join(directory, checksums)),
  size: (await lstat(join(directory, checksums))).size
})
names.push(checksums)

let reference = (await request(`${api}/git/ref/tags/${encodeURIComponent(tag)}`)).object
for (let depth = 0; reference?.type === 'tag' && depth < 4; depth++)
  reference = (await request(`${api}/git/tags/${reference.sha}`)).object
if (reference?.type !== 'commit' || reference.sha !== commit)
  throw new Error('The remote tag does not point to the workflow commit.')

const existing = await request(`${api}/releases/tags/${encodeURIComponent(tag)}`, {}, true)
if (existing && !existing.draft)
  throw new Error('This version is already public; publish a new version rather than replacing it.')
if (existing && existing.tag_name !== tag)
  throw new Error('An existing draft belongs to a different tag.')
const notes =
  `所有平台均通过独立构建与原生 SQLite ABI 检查后发布。\n\n` +
  `- macOS：Apple Silicon（arm64）与 Intel（x64），提供 DMG 和 ZIP。\n` +
  `- Windows：x64 安装程序。\n` +
  `- Linux：x64 AppImage 与 Debian 安装包。\n\n` +
  `${version} 提供多账号邮件、统一收件箱、本地搜索、富文本写信、草稿、附件、持久化同步与操作队列。\n\n` +
  `此版本尚未配置应用代码签名和 macOS 公证，系统可能显示发布者验证提示。\n` +
  `请使用 SHA256SUMS.txt 核对安装包；各依赖声明包含在应用的 THIRD_PARTY_NOTICES.md 中。`
const prerelease = version.includes('-')
const release =
  existing ||
  (await request(`${api}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: commit,
      name: `Better Mail ${version}`,
      body: notes,
      draft: true,
      prerelease
    })
  }))
const upload = new URL(release.upload_url.replace(/\{.*$/, ''))
if (upload.origin !== 'https://uploads.github.com')
  throw new Error('Unexpected release upload host.')

// Retry interrupted drafts without mutating an already published release.
for (const asset of release.assets || [])
  await request(`${api}/releases/assets/${asset.id}`, { method: 'DELETE' })
for (const name of names) {
  const url = new URL(upload)
  url.searchParams.set('name', name)
  await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(hashes.get(name).size)
    },
    body: createReadStream(join(directory, name)),
    duplex: 'half'
  })
}
const assets = await request(`${api}/releases/${release.id}/assets?per_page=100`)
if (
  assets.length !== names.length ||
  names.some((name) => {
    const asset = assets.find((item) => item.name === name)
    const local = hashes.get(name)
    return (
      !asset ||
      asset.state !== 'uploaded' ||
      asset.size !== local.size ||
      asset.digest !== `sha256:${local.hash}`
    )
  })
)
  throw new Error(
    'Uploaded assets failed the complete-set digest verification; the release remains a draft.'
  )
const published = await request(`${api}/releases/${release.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    body: notes,
    draft: false,
    prerelease,
    make_latest: prerelease ? 'false' : 'true'
  })
})
console.log(`Published ${published.html_url}`)
