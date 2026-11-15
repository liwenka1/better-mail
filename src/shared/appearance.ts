import type { WindowTheme } from './window'

export const DEFAULT_ACCENT_COLOR = '#F36AA9'
export const ACCENT_PRESETS = [
  { color: DEFAULT_ACCENT_COLOR, label: '樱粉' },
  { color: '#E66657', label: '珊瑚' },
  { color: '#DAA13A', label: '琥珀' },
  { color: '#4A9B79', label: '松绿' },
  { color: '#448AC4', label: '湖蓝' },
  { color: '#9673D5', label: '紫罗兰' }
] as const

export function normalizeAccentColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : DEFAULT_ACCENT_COLOR
}

function rgb(color: string): number[] {
  return [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16))
}
function mix(color: string, background: string, weight: number): string {
  const foreground = rgb(color)
  const base = rgb(background)
  return `#${foreground
    .map((value, index) =>
      Math.round(value * weight + base[index]! * (1 - weight))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`.toUpperCase()
}
function luminance(color: string): number {
  const linear = rgb(color).map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}
export function colorContrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}

/** Persist the chosen hue; adapt its displayed contrast to the active surfaces. */
export function accentTokens(color: string, theme: WindowTheme): Record<string, string> {
  const chosen = normalizeAccentColor(color)
  const dark = theme === 'dark'
  const surface = dark ? '#192028' : '#FFFFFF'
  const soft = mix(chosen, surface, dark ? 0.18 : 0.13)
  const backgrounds = dark ? [soft, '#263443'] : [soft, '#E2EAF3']
  let accent = chosen
  for (let step = 0; step <= 100; step++) {
    accent = mix(chosen, dark ? '#FFFFFF' : '#000000', 1 - step / 100)
    if (backgrounds.every((background) => colorContrast(accent, background) >= 4.5)) break
  }
  const text =
    colorContrast(accent, '#11161C') > colorContrast(accent, '#FFFFFF') ? '#11161C' : '#FFFFFF'
  return {
    '--accent': accent,
    '--accent-strong': mix(accent, dark ? '#FFFFFF' : '#000000', 0.88),
    '--accent-soft': soft,
    '--accent-text': text,
    '--focus': accent,
    '--unread': accent
  }
}
