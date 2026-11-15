import type { MailBridge, Method, Request, Responses } from '../../shared/contracts'
import { unwrap } from '../../shared/result'
import type { MessageSummary } from '../../shared/model'

declare global {
  interface Window {
    mail: MailBridge
  }
}
export async function request<M extends Method>(
  method: M,
  input: Request<M>
): Promise<Responses[M]> {
  if (!window.mail?.request)
    throw new Error('桌面连接暂不可用，请通过 Electron 桌面应用打开 Better Mail。')
  return unwrap(await window.mail.request(method, input))
}
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '操作未完成，请稍后重试。'
export function dateLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
export const fullDate = (timestamp: number) =>
  new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
export const senderName = (message: MessageSummary) =>
  message.from[0]?.name || message.from[0]?.address.split('@')[0] || '未知发件人'
export const initials = (name: string) =>
  /[\u3400-\u9fff]/.test(name) ? name.slice(0, 1) : name.slice(0, 2).toUpperCase()
export function fileSize(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
export const addresses = (value: string) =>
  value
    .split(/[,;，；\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
  )
