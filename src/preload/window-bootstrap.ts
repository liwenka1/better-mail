import type { WindowChromeState } from '../shared/window'

/** No filesystem, Node handles, or arbitrary values cross this preload boundary. */
export function readChromeBootstrap(
  argv: string[],
  platform: string
): WindowChromeState | undefined {
  const prefix = '--better-mail-window-chrome='
  const argument = argv.findLast((value) => value.startsWith(prefix))
  if (!argument) return undefined
  try {
    const value = JSON.parse(
      decodeURIComponent(argument.slice(prefix.length))
    ) as Partial<WindowChromeState>
    if (
      value.platform !== platform ||
      typeof value.maximized !== 'boolean' ||
      typeof value.fullscreen !== 'boolean' ||
      !['light', 'dark'].includes(String(value.theme)) ||
      !['light', 'dark', 'system'].includes(String(value.themePreference)) ||
      !['macos', 'overlay', 'native'].includes(String(value.controls)) ||
      value.titlebarHeight !== 52 ||
      (value.accentColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(value.accentColor))
    )
      return undefined
    return {
      platform,
      maximized: value.maximized,
      fullscreen: value.fullscreen,
      theme: value.theme!,
      themePreference: value.themePreference!,
      ...(value.accentColor ? { accentColor: value.accentColor.toUpperCase() } : {}),
      titlebarHeight: 52,
      controls: value.controls!
    }
  } catch {
    return undefined
  }
}
