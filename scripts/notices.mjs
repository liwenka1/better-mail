import { execFileSync } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// Includes installed dependencies and copied component source outside that graph.
const licenseArgs = ['licenses', 'list', '--prod', '--json']
const pnpmCli = process.env.npm_execpath
const licenseOutput =
  pnpmCli && /\.[cm]?js$/i.test(pnpmCli)
    ? execFileSync(process.execPath, [pnpmCli, ...licenseArgs], { encoding: 'utf8' })
    : process.platform === 'win32'
      ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'pnpm licenses list --prod --json'], {
          encoding: 'utf8'
        })
      : execFileSync(pnpmCli || 'pnpm', licenseArgs, { encoding: 'utf8' })
const grouped = JSON.parse(licenseOutput)
const packages = Object.values(grouped)
  .flat()
  .sort((a, b) => a.name.localeCompare(b.name))
const texts = new Map()
const inventory = []
for (const dependency of packages) {
  const links = []
  for (const directory of dependency.paths) {
    const names = await readdir(directory)
    for (const name of names.filter((name) =>
      /^(licen[cs]e|copying|notice)(\b|[-_.])/i.test(name)
    )) {
      let content
      try {
        content = await readFile(join(directory, name), 'utf8')
      } catch {
        continue
      }
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
      if (!texts.has(hash)) texts.set(hash, { content, packages: new Set() })
      texts.get(hash).packages.add(`${dependency.name}@${dependency.versions.join(', ')}`)
      links.push(`[${name}](#license-${hash})`)
    }
  }
  inventory.push(
    `| ${dependency.name} | ${dependency.versions.join(', ')} | ${dependency.license} | ${[...new Set(links)].join(', ') || 'See upstream package'} |`
  )
}
const vendored = [
  {
    name: 'shadcn/ui component source',
    version: 'registry snapshot 2026-11-15',
    license: 'MIT',
    notice: 'resources/licenses/shadcn-ui.txt',
    source: 'https://ui.shadcn.com/r/styles/new-york-v4/tooltip.json'
  }
]
for (const dependency of vendored) {
  const content = await readFile(dependency.notice, 'utf8')
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
  if (!texts.has(hash)) texts.set(hash, { content, packages: new Set() })
  texts.get(hash).packages.add(`${dependency.name} (${dependency.version})`)
  inventory.push(
    `| [${dependency.name}](${dependency.source}) | ${dependency.version} | ${dependency.license} | [Included notice](#license-${hash}) |`
  )
}
const sections = [...texts.entries()].map(
  ([hash, value]) =>
    `<a id="license-${hash}"></a>\n\n## ${[...value.packages].join(', ')}\n\n\`\`\`text\n${value.content.trim()}\n\`\`\``
)
await writeFile(
  'THIRD_PARTY_NOTICES.md',
  `# Third-party notices\n\nBetter Mail's own code is MIT licensed. Dependencies and adapted component sources retain their respective licenses and notices. Generated from the installed production dependency graph and vendored-source inventory by \`pnpm notices\`. Electron/Chromium platform notices are also included in the distributed runtime.\n\n| Package | Version | Declared license | Included notices |\n| --- | --- | --- | --- |\n${inventory.join('\n')}\n\n${sections.join('\n\n')}\n`
)
console.log(
  `Recorded ${packages.length} production packages, ${vendored.length} component-source entry and ${texts.size} distinct notice texts.`
)
