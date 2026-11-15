import DOMPurify from 'dompurify'
import { normalizeRemoteImageSource } from '../../shared/remote-images'

const safeRaster = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i
const noRemoteImages: ReadonlyMap<string, string> = new Map()
const maxEmbeddedImageCharacters = 12 * 1024 * 1024
// A document-sized iframe cannot use its own height as an input to its content height.
const viewportHeightValue =
  /(?:\d|\.)\s*(?:[dsl]?(?:vh|vb|vmin|vmax)|cqh|cqb|cqmin|cqmax)\b|\benv\s*\(/i
const heightProperty = /^(?:min-|max-)?height$/

function expandsScrollContainer(element: Element): boolean {
  const style = (element as HTMLElement).style
  return [style?.overflow, style?.overflowY].some((value) =>
    /auto|scroll|overlay/i.test(value || '')
  )
}

const layoutStyles = new Set([
  'display',
  'visibility',
  'overflow',
  'overflow-x',
  'overflow-y',
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-align-all',
  'text-align-last',
  'text-indent',
  'text-transform',
  'vertical-align',
  'white-space',
  'word-break',
  'overflow-wrap',
  'border-collapse',
  'border-spacing',
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'table-layout',
  'box-sizing',
  'float',
  'clear',
  'direction',
  'unicode-bidi',
  'list-style-type',
  'list-style-position',
  'object-fit',
  'object-position'
])

/** Preserve email structure while letting the reader own all foreground/background colors. */
function normalizeInlineStyle(element: Element): void {
  const source = (element as HTMLElement).style
  if (!source?.length) return
  const safe = element.ownerDocument.createElement('span').style
  const expand = expandsScrollContainer(element)
  for (let index = 0; index < source.length; index++) {
    const property = source.item(index)
    const value = source.getPropertyValue(property)
    if (
      !layoutStyles.has(property) ||
      viewportHeightValue.test(value) ||
      (heightProperty.test(property) && (expand || /%|stretch|fill-available/i.test(value))) ||
      (expand && property.startsWith('overflow'))
    )
      continue
    safe.setProperty(property, value)
  }
  if (expand) safe.setProperty('overflow', 'visible')
  // Expand painted shorthands so their geometry survives without their original colors.
  for (const side of ['top', 'right', 'bottom', 'left']) {
    for (const part of ['width', 'style']) {
      const property = `border-${side}-${part}`
      const value = source.getPropertyValue(property)
      if (value && !viewportHeightValue.test(value)) safe.setProperty(property, value)
    }
  }
  for (const property of [
    'text-decoration-line',
    'text-decoration-style',
    'text-decoration-thickness',
    'text-underline-offset'
  ]) {
    const value = source.getPropertyValue(property)
    if (value && !viewportHeightValue.test(value)) safe.setProperty(property, value)
  }
  if (safe.length) element.setAttribute('style', safe.cssText)
  else element.removeAttribute('style')
}

/** Email HTML never gets script execution, network access, or a navigation target. */
function prepareMailHtml(html: string, images: ReadonlyMap<string, string>) {
  const remoteSources = new Set<string>()
  let remoteImageCount = 0
  let loadedImageCount = 0
  let embeddedImageCharacters = 0
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: [
      'script',
      'style',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'video',
      'audio',
      'source',
      'svg',
      'math',
      'link',
      'meta',
      'base'
    ],
    FORBID_ATTR: [
      'srcset',
      'background',
      'poster',
      'action',
      'formaction',
      'target',
      'ping',
      'download',
      'srcdoc',
      'id',
      'name'
    ],
    ALLOW_DATA_ATTR: false
  })
  const document = new DOMParser().parseFromString(clean, 'text/html')
  for (const element of document.body.querySelectorAll('*')) {
    element.removeAttribute('href')
    element.removeAttribute('xlink:href')
    element.removeAttribute('color')
    element.removeAttribute('bgcolor')
    element.removeAttribute('bordercolor')
    if (
      /%/.test(element.getAttribute('height') || '') ||
      viewportHeightValue.test(element.getAttribute('height') || '') ||
      expandsScrollContainer(element)
    )
      element.removeAttribute('height')
    const style = element.getAttribute('style')
    if (style && /url\s*\(|@import|expression\s*\(|behavior\s*:|\\/i.test(style))
      element.removeAttribute('style')
    else normalizeInlineStyle(element)
    if (element.hasAttribute('src')) {
      const src = element.getAttribute('src') || ''
      if (element.tagName !== 'IMG' || !safeRaster.test(src)) {
        if (element.tagName === 'IMG') {
          const source = normalizeRemoteImageSource(src)
          const loaded = source ? images.get(source) : undefined
          if (source) {
            remoteSources.add(source)
            remoteImageCount++
          }
          // A repeated URL must not expand a small mail into an unbounded srcdoc.
          if (
            loaded &&
            embeddedImageCharacters + loaded.length <= maxEmbeddedImageCharacters &&
            safeRaster.test(loaded)
          ) {
            embeddedImageCharacters += loaded.length
            loadedImageCount++
            element.setAttribute('src', loaded)
            continue
          }
          element.setAttribute(
            'alt',
            element.getAttribute('alt') || (source ? '远程图片未加载' : '图片暂不可用')
          )
          element.classList.add('blocked-image')
        }
        element.removeAttribute('src')
      }
    }
  }
  return {
    html: document.body.innerHTML,
    remoteSources: [...remoteSources],
    remoteImageCount,
    loadedImageCount
  }
}

export function sanitizeMailHtml(html: string): string {
  return prepareMailHtml(html, noRemoteImages).html
}

// Embedded documents receive their preferred scheme from the iframe element.
// Both palettes live in one immutable document, so theme changes preserve scroll and selection.
export const MAIL_READER_PALETTES = {
  light: {
    canvas: '#ffffff',
    ink: '#263240',
    muted: '#596777',
    border: '#dce2e8',
    accent: '#9d502e'
  },
  dark: {
    canvas: '#151b22',
    ink: '#ebeef2',
    muted: '#9ba7b5',
    border: '#35414e',
    accent: '#dc9b7b'
  }
} as const
const paletteCss = (palette: (typeof MAIL_READER_PALETTES)[keyof typeof MAIL_READER_PALETTES]) =>
  Object.entries(palette)
    .map(([name, value]) => `--mail-${name}:${value}`)
    .join(';')
const readerStyles = `
  :root{color-scheme:light dark;${paletteCss(MAIL_READER_PALETTES.light)};background:var(--mail-canvas);overflow:hidden}
  @media(prefers-color-scheme:dark){:root{${paletteCss(MAIL_READER_PALETTES.dark)}}}
  body{display:flow-root;height:auto;min-height:0;max-height:none;font:14px/1.85 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;color:var(--mail-ink);margin:0;overflow-wrap:anywhere}
  body,body *{color:var(--mail-ink)!important;background-color:transparent!important;background-image:none!important;border-color:var(--mail-border)!important;outline-color:var(--mail-border)!important;-webkit-text-fill-color:currentColor!important;text-shadow:none!important;box-shadow:none!important;filter:none!important;mix-blend-mode:normal!important;opacity:1!important}
  body{background-color:var(--mail-canvas)!important}
  img{max-width:100%!important;height:auto}
  table{max-width:100%}
  a,a *{color:var(--mail-accent)!important;text-decoration:none}
  .blocked-image{display:inline-block;font-size:12px;color:var(--mail-muted)!important}
  blockquote{border-left:3px solid var(--mail-border);padding-left:16px;margin-left:0}
  blockquote,blockquote *{color:var(--mail-muted)!important}
  pre{white-space:pre-wrap}
`

export function mailDocument(html: string): string {
  return prepareMailDocument(html).document
}

export function prepareMailDocument(
  html: string,
  images: ReadonlyMap<string, string> = noRemoteImages
) {
  const sanitized = prepareMailHtml(html, images)
  return {
    document: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; form-action 'none'; base-uri 'none'; connect-src 'none'"><style>${readerStyles}</style></head><body>${sanitized.html}</body></html>`,
    remoteSources: sanitized.remoteSources,
    remoteImageCount: sanitized.remoteImageCount,
    loadedImageCount: sanitized.loadedImageCount
  }
}
