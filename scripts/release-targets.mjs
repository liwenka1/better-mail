import { readFile } from 'node:fs/promises'

export const releaseTargets = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64', os: 'mac', extensions: ['dmg', 'zip'] },
  'mac-x64': { platform: 'darwin', arch: 'x64', os: 'mac', extensions: ['dmg', 'zip'] },
  'win-x64': { platform: 'win32', arch: 'x64', os: 'win', extensions: ['exe'] },
  'linux-x64': { platform: 'linux', arch: 'x64', os: 'linux', extensions: ['AppImage', 'deb'] }
}

export async function releaseVersion() {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'))
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version))
    throw new Error('package.json must contain a valid release version.')
  const expectedTag = `v${version}`
  if (
    process.env.GITHUB_REF?.startsWith('refs/tags/') &&
    process.env.GITHUB_REF_NAME !== expectedTag
  )
    throw new Error(`Release tag must equal ${expectedTag}.`)
  return version
}

export function artifactNames(version, target) {
  const targets = target ? [target] : Object.keys(releaseTargets)
  return targets.flatMap((name) => {
    const configuration = releaseTargets[name]
    if (!configuration) throw new Error(`Unsupported release target: ${name}`)
    return configuration.extensions.map(
      (extension) => `Better-Mail-${version}-${configuration.os}-${configuration.arch}.${extension}`
    )
  })
}
