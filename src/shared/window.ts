/** Desktop-only chrome state. It never contains native handles or window IDs. */
export const TITLE_BAR_HEIGHT = 52
export type WindowThemePreference = 'light' | 'dark' | 'system'
export type WindowTheme = 'light' | 'dark'
export interface WindowChromeState {
  platform: string
  maximized: boolean
  fullscreen: boolean
  theme: WindowTheme
  themePreference: WindowThemePreference
  accentColor?: string
  titlebarHeight: number
  controls: 'macos' | 'overlay' | 'native'
}
export type WindowCommand =
  | { action: 'minimize' | 'toggleMaximize' | 'close' }
  | { action: 'theme'; theme: WindowThemePreference }
  | { action: 'accent'; color: string }
export interface WindowPreferences {
  themePreference: WindowThemePreference
  accentColor: string
}
export interface WindowCloseRequest {
  requestId: string
  reason: 'close' | 'quit'
}
