import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
const checks = [
  [
    'src/core',
    /(?:from\s*|import\s*\()\s*['"](?:electron|react|drizzle-orm|better-sqlite3|imapflow|nodemailer|googleapis|@azure\/|.*infrastructure\/|.*renderer\/|.*main\/)/g
  ],
  [
    'src/shared',
    /(?:from\s*|import\s*\()\s*['"](?:electron|react|node:|.*core\/|.*infrastructure\/|.*main\/|.*renderer\/)/g
  ],
  [
    'src/renderer/src',
    /(?:from\s*|import\s*\()\s*['"](?:electron|node:|better-sqlite3|drizzle-orm|imapflow|nodemailer|.*core\/|.*infrastructure\/|.*main\/)/g
  ],
  [
    'src/renderer/src',
    /(?:from\s*|import\s*\()\s*['"](?:@radix-ui\/|radix-ui['"])/g,
    '/components/ui/'
  ]
]
async function walk(path) {
  const files = []
  for (const item of await readdir(path, { withFileTypes: true })) {
    const full = join(path, item.name)
    if (item.isDirectory()) files.push(...(await walk(full)))
    else if (/\.[cm]?[jt]sx?$/.test(item.name)) files.push(full)
  }
  return files
}
let failed = false
for (const [directory, forbidden, allowedPath] of checks) {
  for (const file of await walk(directory)) {
    if (allowedPath && file.replaceAll('\\', '/').includes(allowedPath)) continue
    forbidden.lastIndex = 0
    const matches = [...(await readFile(file, 'utf8')).matchAll(forbidden)]
    if (matches.length) {
      failed = true
      console.error(`Forbidden dependency in ${file}: ${matches.map((m) => m[0]).join(', ')}`)
    }
  }
}
if (failed) process.exitCode = 1
else console.log('Architecture dependency boundaries passed.')
