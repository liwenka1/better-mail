import { readFile } from 'node:fs/promises'

export const releaseTargets = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64', os: 'mac', extensions: ['dmg', 'zip'] },
  'mac-x64': { platform: 'darwin', arch: 'x64', os: 'mac', extensions: ['dmg', 'zip'] },
  'win-x64': { platform: 'win32', arch: 'x64', os: 'win', extensions: ['exe'] },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    os: 'linux',
    extensions: ['AppImage', 'deb'],
    artifactArch: { AppImage: 'x86_64', deb: 'amd64' }
  }
}

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

export function validateReleaseVersion(version) {
  const match = typeof version === 'string' && version.match(versionPattern)
  if (
    !match ||
    version.length > 64 ||
    !match.slice(1, 4).every((part) => Number.isSafeInteger(Number(part)))
  )
    throw new Error('Use a release version such as 0.1.1 or 0.2.0-beta.1 (without build metadata).')
  return version
}

export function compareReleaseVersions(left, right) {
  const a = validateReleaseVersion(left).match(versionPattern)
  const b = validateReleaseVersion(right).match(versionPattern)
  for (let index = 1; index <= 3; index++) {
    if (BigInt(a[index]) !== BigInt(b[index])) return BigInt(a[index]) > BigInt(b[index]) ? 1 : -1
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1
  const preA = a[4].split('.')
  const preB = b[4].split('.')
  for (let index = 0; index < Math.max(preA.length, preB.length); index++) {
    if (preA[index] === preB[index]) continue
    if (preA[index] === undefined || preB[index] === undefined)
      return preA[index] === undefined ? -1 : 1
    const numericA = /^\d+$/.test(preA[index])
    const numericB = /^\d+$/.test(preB[index])
    if (numericA && numericB) return BigInt(preA[index]) > BigInt(preB[index]) ? 1 : -1
    if (numericA !== numericB) return numericA ? -1 : 1
    return preA[index] > preB[index] ? 1 : -1
  }
  return 0
}

export async function releaseVersion() {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'))
  validateReleaseVersion(version)
  const expectedTag = `v${version}`
  if (
    process.env.GITHUB_REF?.startsWith('refs/tags/') &&
    process.env.GITHUB_REF_NAME !== expectedTag
  )
    throw new Error(`Release tag must equal ${expectedTag}.`)
  if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== expectedTag)
    throw new Error(`Prepared release tag must equal ${expectedTag}.`)
  return version
}

export function artifactNames(version, target) {
  const targets = target ? [target] : Object.keys(releaseTargets)
  return targets.flatMap((name) => {
    const configuration = releaseTargets[name]
    if (!configuration) throw new Error(`Unsupported release target: ${name}`)
    return configuration.extensions.map(
      (extension) =>
        `Better-Mail-${version}-${configuration.os}-${configuration.artifactArch?.[extension] || configuration.arch}.${extension}`
    )
  })
}
