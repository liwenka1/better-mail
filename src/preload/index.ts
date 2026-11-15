import { contextBridge, ipcRenderer } from 'electron'
import { IPC_EVENT, IPC_REQUEST } from '../shared/channels'
import type { MailBridge, Method, Request, Responses } from '../shared/contracts'
import type { AppEvent, Result } from '../shared/model'
import { readChromeBootstrap } from './window-bootstrap'

const bridge: MailBridge = {
  request: <M extends Method>(method: M, input: Request<M>) =>
    ipcRenderer.invoke(IPC_REQUEST, method, input) as Promise<Result<Responses[M]>>,
  subscribe(listener: (event: AppEvent) => void) {
    const handle = (_event: Electron.IpcRendererEvent, data: AppEvent) => listener(data)
    ipcRenderer.on(IPC_EVENT, handle)
    return () => ipcRenderer.removeListener(IPC_EVENT, handle)
  },
  platform: process.platform,
  initialChrome: readChromeBootstrap(process.argv, process.platform)
}
contextBridge.exposeInMainWorld('mail', bridge)
