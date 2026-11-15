import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { WindowChromeState, WindowThemePreference } from '../../shared/window'
import { errorMessage, request } from './lib'
import { accentTokens, DEFAULT_ACCENT_COLOR } from '../../shared/appearance'

const platform = window.mail?.platform || 'linux'
const fallback: WindowChromeState = {
  platform,
  maximized: false,
  fullscreen: false,
  theme: 'dark',
  themePreference: 'dark',
  accentColor: DEFAULT_ACCENT_COLOR,
  titlebarHeight: 52,
  controls: platform === 'darwin' ? 'macos' : 'overlay'
}

interface ControlsOverlay {
  visible: boolean
  getTitlebarAreaRect(): DOMRect
  addEventListener(name: 'geometrychange', listener: () => void): void
  removeEventListener(name: 'geometrychange', listener: () => void): void
}

export function useWindowChrome(notify: (message: string) => void) {
  const [chrome, setChrome] = useState<WindowChromeState>(window.mail?.initialChrome || fallback)
  const [updating, setUpdating] = useState(false)
  useEffect(() => {
    let alive = true
    void request('window.chrome', {})
      .then((state) => {
        if (alive) setChrome(state)
      })
      .catch((error) => notify(errorMessage(error)))
    const unsubscribe = window.mail?.subscribe((event) => {
      if (event.type === 'window.chrome.changed') setChrome(event.state)
    })
    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [notify])
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.theme = chrome.theme
    root.dataset.platform = chrome.platform
    root.dataset.fullscreen = String(chrome.fullscreen)
    root.dataset.maximized = String(chrome.maximized)
    root.dataset.windowControls = chrome.controls
    root.style.colorScheme = chrome.theme
    for (const [token, value] of Object.entries(
      accentTokens(chrome.accentColor || DEFAULT_ACCENT_COLOR, chrome.theme)
    ))
      root.style.setProperty(token, value)
    root.style.setProperty('--titlebar-height', `${chrome.titlebarHeight}px`)
    const overlay = (navigator as Navigator & { windowControlsOverlay?: ControlsOverlay })
      .windowControlsOverlay
    const geometry = () => {
      const area = overlay?.visible ? overlay.getTitlebarAreaRect() : null
      const left = chrome.fullscreen
        ? 0
        : chrome.platform === 'darwin'
          ? 80
          : area && area.width > 0
            ? area.x
            : 0
      const right =
        chrome.fullscreen || chrome.platform === 'darwin' || chrome.controls === 'native'
          ? 0
          : area && area.width > 0
            ? Math.max(0, window.innerWidth - area.x - area.width)
            : 138
      root.style.setProperty('--window-inset-left', `${left}px`)
      root.style.setProperty('--window-inset-right', `${right}px`)
    }
    geometry()
    overlay?.addEventListener('geometrychange', geometry)
    window.addEventListener('resize', geometry)
    return () => {
      overlay?.removeEventListener('geometrychange', geometry)
      window.removeEventListener('resize', geometry)
    }
  }, [chrome])
  const setTheme = useCallback(
    async (theme: WindowThemePreference) => {
      setUpdating(true)
      try {
        setChrome(await request('window.command', { action: 'theme', theme }))
      } catch (error) {
        notify(errorMessage(error))
      } finally {
        setUpdating(false)
      }
    },
    [notify]
  )
  const setAccentColor = useCallback(
    async (color: string) => {
      try {
        setChrome(await request('window.command', { action: 'accent', color }))
      } catch (error) {
        notify(errorMessage(error))
        throw error
      }
    },
    [notify]
  )
  return { chrome, setTheme, setAccentColor, updating }
}
