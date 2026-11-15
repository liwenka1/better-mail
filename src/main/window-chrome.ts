import type {
  BrowserWindowConstructorOptions,
  MenuItemConstructorOptions,
  TitleBarOverlayOptions
} from 'electron'
import { MailError } from '../shared/model'
import {
  TITLE_BAR_HEIGHT,
  type WindowChromeState,
  type WindowCommand,
  type WindowTheme,
  type WindowThemePreference
} from '../shared/window'
import { windowCommandSchema } from '../shared/window-contracts'
import { DEFAULT_ACCENT_COLOR, normalizeAccentColor } from '../shared/appearance'

export const WINDOW_PALETTE = {
  light: { color: '#f8f9fb', symbolColor: '#263240' },
  dark: { color: '#161b22', symbolColor: '#ebeef2' }
} as const

export interface WindowChromePolicy {
  controls: WindowChromeState['controls']
  options: Pick<
    BrowserWindowConstructorOptions,
    | 'titleBarStyle'
    | 'titleBarOverlay'
    | 'trafficLightPosition'
    | 'backgroundColor'
    | 'autoHideMenuBar'
    | 'thickFrame'
  >
}

/** Keep the OS's actual window controls/hit testing; never paint replacements. */
export function windowChromePolicy(
  platform: string,
  theme: WindowTheme,
  nativeFrame = false
): WindowChromePolicy {
  const backgroundColor = WINDOW_PALETTE[theme].color
  if (platform === 'darwin')
    return {
      controls: 'macos',
      options: {
        titleBarStyle: 'hiddenInset',
        titleBarOverlay: true,
        trafficLightPosition: { x: 18, y: 19 },
        backgroundColor
      }
    }
  if ((platform === 'win32' || platform === 'linux') && !nativeFrame)
    return {
      controls: 'overlay',
      options: {
        titleBarStyle: 'hidden',
        titleBarOverlay: { ...WINDOW_PALETTE[theme], height: TITLE_BAR_HEIGHT },
        backgroundColor,
        autoHideMenuBar: true,
        ...(platform === 'win32' ? { thickFrame: true } : {})
      }
    }
  return {
    controls: 'native',
    options: { titleBarStyle: 'default', backgroundColor, autoHideMenuBar: true }
  }
}

/** Native roles provide editing/zoom/fullscreen shortcuts and platform menus. */
export function applicationMenuTemplate(
  platform: string,
  development = false
): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]
  if (development) view.push({ type: 'separator' }, { role: 'toggleDevTools' })
  return [
    ...(platform === 'darwin'
      ? [{ role: 'appMenu' as const }]
      : [{ label: '文件', submenu: [{ role: 'close' as const }, { role: 'quit' as const }] }]),
    { label: '编辑', role: 'editMenu' },
    { label: '显示', submenu: view },
    platform === 'darwin'
      ? { label: '窗口', role: 'windowMenu' }
      : { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] }
  ]
}

export interface ChromeWindow {
  isDestroyed(): boolean
  isMaximized(): boolean
  isFullScreen(): boolean
  minimize(): void
  maximize(): void
  unmaximize(): void
  close(): void
  setBackgroundColor(color: string): void
  setTitleBarOverlay(options: TitleBarOverlayOptions): void
  on(event: string, callback: () => void): unknown
  removeListener(event: string, callback: () => void): unknown
}
export interface ThemeHost {
  shouldUseDarkColors: boolean
  themeSource: WindowThemePreference
  on(event: 'updated', callback: () => void): unknown
  removeListener(event: 'updated', callback: () => void): unknown
}
interface ChromeOptions {
  platform: string
  nativeTheme: ThemeHost
  preference: WindowThemePreference
  accentColor?: string
  savePreference: (preference: WindowThemePreference, accentColor: string) => Promise<void>
  emit: (window: ChromeWindow, state: WindowChromeState) => void
  requestClose: (window: ChromeWindow) => void
}

export class WindowChromeController {
  private preference: WindowThemePreference
  private accent: string
  private readonly windows = new Map<
    ChromeWindow,
    { controls: WindowChromeState['controls']; dispose: () => void }
  >()
  private writes: Promise<unknown> = Promise.resolve()
  private readonly themeChanged = (): void => {
    this.refreshAll()
  }

  constructor(private readonly options: ChromeOptions) {
    this.preference = options.preference
    this.accent = normalizeAccentColor(options.accentColor || DEFAULT_ACCENT_COLOR)
    options.nativeTheme.themeSource = this.preference
    options.nativeTheme.on('updated', this.themeChanged)
  }
  get theme(): WindowTheme {
    return this.preference === 'system'
      ? this.options.nativeTheme.shouldUseDarkColors
        ? 'dark'
        : 'light'
      : this.preference
  }
  get themePreference(): WindowThemePreference {
    return this.preference
  }
  get accentColor(): string {
    return this.accent
  }
  register(window: ChromeWindow, controls: WindowChromeState['controls']): void {
    if (this.windows.has(window)) return
    const changed = (): void => {
      if (!window.isDestroyed()) this.options.emit(window, this.state(window))
    }
    const events = ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']
    for (const event of events) window.on(event, changed)
    const closed = (): void => {
      this.windows.get(window)?.dispose()
      this.windows.delete(window)
    }
    window.on('closed', closed)
    this.windows.set(window, {
      controls,
      dispose: () => {
        for (const event of events) window.removeListener(event, changed)
        window.removeListener('closed', closed)
      }
    })
    this.applyTheme(window)
  }
  state(window: ChromeWindow): WindowChromeState {
    const entry = this.windows.get(window)
    if (!entry || window.isDestroyed()) throw new MailError('NOT_FOUND', '应用窗口已关闭。')
    return {
      platform: this.options.platform,
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
      theme: this.theme,
      themePreference: this.preference,
      accentColor: this.accent,
      titlebarHeight: TITLE_BAR_HEIGHT,
      controls: entry.controls
    }
  }
  async command(window: ChromeWindow, input: unknown): Promise<WindowChromeState> {
    const parsed = windowCommandSchema.safeParse(input)
    if (!parsed.success) throw new MailError('VALIDATION', '窗口操作无效。')
    this.state(window)
    const command: WindowCommand = parsed.data
    if (command.action === 'theme' || command.action === 'accent') {
      const change = this.writes
        .catch(() => undefined)
        .then(async () => {
          const preference = command.action === 'theme' ? command.theme : this.preference
          const accent = command.action === 'accent' ? command.color : this.accent
          await this.options.savePreference(preference, accent)
          this.preference = preference
          this.accent = accent
          if (command.action === 'theme') {
            this.options.nativeTheme.themeSource = preference
            this.refreshAll()
          } else this.publishAll()
        })
      this.writes = change
      await change
    } else if (command.action === 'minimize') window.minimize()
    else if (command.action === 'toggleMaximize') {
      // Fullscreen is controlled by the OS/menu; do not silently replace it with maximization.
      if (!window.isFullScreen()) window.isMaximized() ? window.unmaximize() : window.maximize()
    } else this.options.requestClose(window)
    return this.state(window)
  }
  private applyTheme(window: ChromeWindow): void {
    if (window.isDestroyed()) return
    window.setBackgroundColor(WINDOW_PALETTE[this.theme].color)
    if (this.windows.get(window)?.controls === 'overlay')
      window.setTitleBarOverlay({ ...WINDOW_PALETTE[this.theme], height: TITLE_BAR_HEIGHT })
  }
  private refreshAll(): void {
    for (const window of this.windows.keys()) if (!window.isDestroyed()) this.applyTheme(window)
    this.publishAll()
  }
  private publishAll(): void {
    for (const window of this.windows.keys())
      if (!window.isDestroyed()) this.options.emit(window, this.state(window))
  }
  dispose(): void {
    this.options.nativeTheme.removeListener('updated', this.themeChanged)
    for (const entry of this.windows.values()) entry.dispose()
    this.windows.clear()
  }
}
