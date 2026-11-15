export interface RemoteImagesResult {
  images: Array<{ source: string; dataUrl: string }>
  failed: number
  skipped: number
}

/** The host separately checks the destination's resolved network address. */
export function normalizeRemoteImageSource(raw: string): string | null {
  if (!raw || raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw)) return null
  try {
    const value = raw.trim()
    const url = new URL(value.startsWith('//') ? `https:${value}` : value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.port
    )
      return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}
