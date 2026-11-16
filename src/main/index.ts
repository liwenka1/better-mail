import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  powerMonitor,
  session,
  shell
} from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC_EVENT, IPC_REQUEST, methods, requestSchemas, type Method } from '../shared/contracts'
import { MailError, type AppEvent, type Result } from '../shared/model'
import { TITLE_BAR_HEIGHT, type WindowChromeState } from '../shared/window'
import type { DownloadedAttachment } from '../core/ports'
import type { RemoteImageCacheContext } from '../core/store'
import { SystemVault } from './vault'
import { MailWorkerClient } from './worker-client'
import { authorizeMailbox } from './oauth'
import {
  applicationMenuTemplate,
  WindowChromeController,
  windowChromePolicy
} from './window-chrome'
import { bindRendererCloseLifecycle, WindowCloseCoordinator } from './window-close'
import { isTrustedWindowRequest } from './ipc-security'
import { readWindowPreferences, writeWindowPreferences } from './window-settings'
import { SyncWakeController } from './sync-wake'
import { RemoteImageLoader } from './remote-images'

app.setName('Better Mail')
if (process.env.BETTER_MAIL_USER_DATA) app.setPath('userData', process.env.BETTER_MAIL_USER_DATA)
let worker: MailWorkerClient | undefined
let mainWindow: BrowserWindow | undefined
let quitting = false
let authorizing = false
let chrome: WindowChromeController | undefined
let syncWake: SyncWakeController | undefined
let remoteImages: RemoteImageLoader | undefined
const rendererFile = join(__dirname, '../renderer/index.html')
function developmentRendererUrl(): string | undefined {
  if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) return undefined
  const url = new URL(process.env.ELECTRON_RENDERER_URL)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('The development renderer must use a loopback HTTP address.')
  return url.href
}
const developmentUrl = developmentRendererUrl()
const trustedUrl = new URL(developmentUrl || pathToFileURL(rendererFile).href).href
function sendWindowEvent(window: BrowserWindow, event: AppEvent): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  if (
    !isTrustedWindowRequest(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      window.webContents,
      trustedUrl
    )
  )
    return
  window.webContents.send(IPC_EVENT, event)
}
const windowClose = new WindowCloseCoordinator({
  reveal: (window) => {
    const target = window as BrowserWindow
    if (target.isDestroyed()) return
    // A user-requested quit can originate from the Dock or native menu while
    // the editor is minimized. Make its save/cancel prompt visible first.
    if (target.isMinimized()) target.restore()
    target.show()
    target.focus()
  },
  emit: (window, request) =>
    sendWindowEvent(window as BrowserWindow, { type: 'window.close.requested', ...request }),
  quit: async () => {
    if (quitting) return
    quitting = true
    remoteImages?.cancelAll()
    syncWake?.dispose()
    // Approval ends the editing session. Do not leave an interactive composer
    // visible while a slow in-flight mail operation is being shut down.
    for (const window of BrowserWindow.getAllWindows()) window.hide()
    try {
      await worker?.stop()
    } finally {
      chrome?.dispose()
      windowClose.allowQuit()
      app.quit()
    }
  }
})

function createWindow() {
  if (!chrome) throw new Error('Window appearance must load before creating a window.')
  let policy = windowChromePolicy(
    process.platform,
    chrome.theme,
    process.platform === 'linux' && process.env.BETTER_MAIL_NATIVE_FRAME === '1'
  )
  const options = () => ({
    width: 1440,
    height: 940,
    minWidth: 1050,
    minHeight: 700,
    show: false,
    title: 'Better Mail',
    ...policy.options,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      additionalArguments: [
        `--better-mail-window-chrome=${encodeURIComponent(
          JSON.stringify({
            platform: process.platform,
            maximized: false,
            fullscreen: false,
            theme: chrome!.theme,
            themePreference: chrome!.themePreference,
            accentColor: chrome!.accentColor,
            titlebarHeight: TITLE_BAR_HEIGHT,
            controls: policy.controls
          } satisfies WindowChromeState)
        )}`
      ]
    }
  })
  let window: BrowserWindow
  try {
    window = new BrowserWindow(options())
  } catch (error) {
    if (process.platform !== 'linux' || policy.controls !== 'overlay') throw error
    // Desktop environments can opt into the same fallback explicitly through
    // BETTER_MAIL_NATIVE_FRAME=1; do not replace OS controls with fake HTML buttons.
    policy = windowChromePolicy(process.platform, chrome.theme, true)
    window = new BrowserWindow(options())
  }
  mainWindow = window
  syncWake?.register(window)
  windowClose.register(window)
  chrome.register(window, policy.controls)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (windowClose.interceptClose(window)) event.preventDefault()
  })
  window.webContents.on('did-finish-load', () => {
    if (chrome)
      sendWindowEvent(window, { type: 'window.chrome.changed', state: chrome.state(window) })
  })
  const detachCloseLifecycle = bindRendererCloseLifecycle(windowClose, window, window.webContents)
  window.on('closed', () => {
    remoteImages?.cancelAll()
    detachCloseLifecycle()
    windowClose.unregister(window)
    if (mainWindow === window) mainWindow = undefined
  })
  if (developmentUrl) void window.loadURL(developmentUrl)
  else void window.loadFile(rendererFile)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (quitting) return
    mainWindow?.show()
    mainWindow?.focus()
  })
  void app
    .whenReady()
    .then(async () => {
      const preferencePath = join(app.getPath('userData'), 'window-preferences.json')
      const preferences = await readWindowPreferences(preferencePath)
      chrome = new WindowChromeController({
        platform: process.platform,
        nativeTheme,
        preference: preferences.themePreference,
        accentColor: preferences.accentColor,
        savePreference: (themePreference, accentColor) =>
          writeWindowPreferences(preferencePath, { themePreference, accentColor }),
        emit: (window, state) =>
          sendWindowEvent(window as BrowserWindow, { type: 'window.chrome.changed', state }),
        requestClose: (window) => windowClose.request(window, 'close')
      })
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(applicationMenuTemplate(process.platform, !app.isPackaged))
      )
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false)
      )
      session.defaultSession.setPermissionCheckHandler(() => false)
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const csp = developmentUrl
          ? `default-src 'self'; script-src 'self' 'nonce-${process.env.BETTER_MAIL_DEV_NONCE}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; frame-src 'self' about:; object-src 'none'; base-uri 'none'`
          : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'self' about:; object-src 'none'; base-uri 'none'"
        callback({
          responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] }
        })
      })
      const dataDir = app.getPath('userData')
      worker = new MailWorkerClient(
        dataDir,
        new SystemVault(join(dataDir, 'credentials')),
        (event) => {
          for (const window of BrowserWindow.getAllWindows())
            window.webContents.send(IPC_EVENT, event)
        }
      )
      remoteImages = new RemoteImageLoader({
        cache: {
          read: async (scope) =>
            (await worker!.request('$images.context', scope)) as RemoteImageCacheContext,
          write: async (scope, images) => {
            await worker!.request('$images.save', { ...scope, images })
          }
        }
      })
      syncWake = new SyncWakeController({
        powerMonitor,
        isOnline: () => net.isOnline(),
        notify: (reason) => worker!.request('$sync.wake', { reason })
      })
      ipcMain.handle(
        IPC_REQUEST,
        async (event, rawMethod: unknown, rawInput: unknown): Promise<Result<unknown>> => {
          try {
            const requestWindow = mainWindow
            if (
              !requestWindow ||
              !isTrustedWindowRequest(event, requestWindow.webContents, trustedUrl)
            )
              throw new MailError('VALIDATION', '拒绝非应用窗口的请求')
            if (typeof rawMethod !== 'string' || !methods.includes(rawMethod as Method))
              throw new MailError('VALIDATION', '未知操作')
            const method = rawMethod as Method
            const parsed = requestSchemas[method].safeParse(rawInput)
            if (!parsed.success)
              throw new MailError('VALIDATION', '输入不完整或格式不正确，请检查后重试')
            const input = parsed.data
            let value: unknown
            if (method === 'window.chrome') value = chrome!.state(requestWindow)
            else if (method === 'window.command')
              value = await chrome!.command(requestWindow, input)
            else if (method === 'window.close.ready') windowClose.rendererReady(requestWindow)
            else if (method === 'window.close.resolve') windowClose.resolve(requestWindow, input)
            else if (method === 'accounts.oauth') {
              if (authorizing)
                throw new MailError('VALIDATION', '已有授权正在进行，请先完成浏览器中的授权')
              authorizing = true
              try {
                const identity = await authorizeMailbox(
                  requestSchemas['accounts.oauth'].parse(input),
                  async (url) => {
                    const parsedUrl = new URL(url)
                    if (
                      parsedUrl.protocol !== 'https:' ||
                      !['accounts.google.com', 'login.microsoftonline.com'].includes(
                        parsedUrl.hostname
                      )
                    )
                      throw new MailError('VALIDATION', '无效的授权地址')
                    await shell.openExternal(url)
                  }
                )
                value = await worker!.request('$oauth.add', identity)
              } finally {
                authorizing = false
              }
            } else if (method === 'messages.cachedImages') {
              value = await remoteImages!.cached(input)
            } else if (method === 'messages.loadImages') {
              value = await remoteImages!.load(input)
            } else if (method === 'attachments.pick') {
              const result = await dialog.showOpenDialog(requestWindow, {
                title: '选择邮件附件',
                properties: ['openFile', 'multiSelections']
              })
              value = result.canceled
                ? []
                : await worker!.request('$attachments.import', { paths: result.filePaths })
            } else if (method === 'attachments.save') {
              const attachment = (await worker!.request(
                '$attachments.download',
                input
              )) as DownloadedAttachment
              const name =
                basename(attachment.filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'attachment'
              const result = await dialog.showSaveDialog(requestWindow, {
                title: '保存附件',
                defaultPath: join(app.getPath('downloads'), name)
              })
              if (result.canceled || !result.filePath) value = { saved: false }
              else {
                await writeFile(result.filePath, attachment.content)
                value = { saved: true }
              }
            } else value = await worker!.request(method, input)
            return { ok: true, value }
          } catch (error) {
            const e =
              error instanceof MailError ? error : new MailError('INTERNAL', '操作未完成，请重试')
            return {
              ok: false,
              error: { code: e.code, message: e.message, retryable: e.retryable }
            }
          }
        }
      )
      createWindow()
      app.on('activate', () => {
        if (quitting) return
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((error) => {
      dialog.showErrorBox(
        'Better Mail 启动失败',
        String(error instanceof Error ? error.message : '请重试')
      )
      app.quit()
    })
}
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  windowClose.request(mainWindow, 'quit')
})
app.once('will-quit', () => syncWake?.dispose())
