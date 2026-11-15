import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { artifactNames, releaseTargets, releaseVersion } from './release-targets.mjs'

const [command, target, option] = process.argv.slice(2)
const version = await releaseVersion()
if (command === 'version') {
  console.log(`Release version: ${version}`)
} else if (command === 'native') {
  const configuration = releaseTargets[target]
  if (
    !configuration ||
    process.platform !== configuration.platform ||
    process.arch !== configuration.arch
  )
    throw new Error(`Use a native ${target} runner for this build.`)
  const require = createRequire(import.meta.url)
  let executable = require('electron')
  let packagePath = resolve('package.json')
  if (option === '--packaged') {
    const folder = {
      'mac-arm64': 'mac-arm64',
      'mac-x64': 'mac',
      'win-x64': 'win-unpacked',
      'linux-x64': 'linux-unpacked'
    }[target]
    const root = resolve('release', folder)
    const resources =
      configuration.platform === 'darwin'
        ? join(root, 'Better Mail.app', 'Contents', 'Resources')
        : join(root, 'resources')
    executable =
      configuration.platform === 'darwin'
        ? join(root, 'Better Mail.app', 'Contents', 'MacOS', 'Better Mail')
        : join(root, configuration.platform === 'win32' ? 'Better Mail.exe' : 'better-mail')
    packagePath = join(resources, 'app.asar', 'package.json')
  } else if (option) throw new Error(`Unknown native verification option: ${option}`)
  const code = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const load = require('node:module').createRequire(process.argv[1]);
    const metadata = load('./package.json');
    assert.equal(process.arch, process.argv[2]);
    assert.equal(metadata.version, process.argv[3]);
    assert.ok(process.versions.electron);
    const Database = load('better-sqlite3');
    const database = new Database(':memory:');
    database.exec('CREATE TABLE release_check (value INTEGER NOT NULL)');
    database.prepare('INSERT INTO release_check VALUES (?)').run(7);
    assert.equal(database.prepare('SELECT value FROM release_check').get().value, 7);
    database.close();
    if (process.argv[4] === 'packaged') {
      const root = path.dirname(process.argv[1]);
      for (const file of ['out/main/index.cjs', 'out/main/mail-worker.cjs', 'out/preload/index.cjs', 'out/renderer/index.html', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
        assert.ok(fs.existsSync(path.join(root, file)), 'Missing packaged file: ' + file);
    }
    console.log('Electron ' + process.versions.electron + ' / SQLite ABI / ' + process.arch + ' verified');
  `
  const result = spawnSync(
    executable,
    [
      '-e',
      code,
      packagePath,
      configuration.arch,
      version,
      option === '--packaged' ? 'packaged' : 'development'
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
      windowsHide: true,
      timeout: 60_000
    }
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Native verification failed (${result.status}).`)
} else if (command === 'stage') {
  const expected = artifactNames(version, target)
  await mkdir('release/upload', { recursive: true })
  for (const name of expected) {
    const file = join('release', name)
    const info = await lstat(file)
    if (!info.isFile() || info.size < 1024) throw new Error(`Missing or invalid installer: ${name}`)
    await copyFile(file, join('release/upload', name))
  }
  const actual = await readdir('release/upload')
  if (actual.length !== expected.length || actual.some((name) => !expected.includes(name)))
    throw new Error('The upload directory contains unexpected build artifacts.')
  console.log(`Prepared ${target}: ${expected.join(', ')}`)
} else
  throw new Error('Use release-check.mjs version | native <target> [--packaged] | stage <target>.')
