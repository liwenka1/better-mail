import { readFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { windowPreferencesSchema } from '../shared/window-contracts'
import type { WindowPreferences } from '../shared/window'
import { DEFAULT_ACCENT_COLOR } from '../shared/appearance'
import { MailError } from '../shared/model'

/** UI preferences only; never reuse the mail database or credential vault. */
export async function readWindowPreferences(path: string): Promise<WindowPreferences> {
  try {
    const parsed = windowPreferencesSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success
      ? parsed.data
      : { themePreference: 'dark', accentColor: DEFAULT_ACCENT_COLOR }
  } catch {
    return { themePreference: 'dark', accentColor: DEFAULT_ACCENT_COLOR }
  }
}

export async function writeWindowPreferences(
  path: string,
  preference: WindowPreferences
): Promise<void> {
  const value = windowPreferencesSchema.parse(preference)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } catch {
    await unlink(temporary).catch(() => undefined)
    throw new MailError('INTERNAL', '无法保存外观设置，请检查应用数据目录权限。')
  }
}
