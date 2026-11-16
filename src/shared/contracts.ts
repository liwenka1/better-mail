import { z } from 'zod'
import { windowCloseResolutionSchema, windowCommandSchema } from './window-contracts'
import type { WindowChromeState } from './window'
import type { RemoteImagesResult } from './remote-images'
import type {
  Account,
  AppEvent,
  AppSnapshot,
  Draft,
  DraftAttachment,
  MessageDetail,
  MessagePage,
  Operation,
  OperationPage,
  Result
} from './model'

const id = z.string().min(1).max(512)
const address = z.email().max(320)
const imageScope = z
  .object({ accountId: id, messageId: id, bodyHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
const endpoint = z.object({
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:-]+$/),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean()
})
const draft = z.object({
  id: id.optional(),
  accountId: id,
  to: z.array(address).max(100),
  cc: z.array(address).max(100),
  bcc: z.array(address).max(100),
  subject: z
    .string()
    .max(998)
    .refine((s) => !/[\r\n]/.test(s)),
  text: z.string().max(2_000_000),
  html: z.string().max(2_000_000).nullable(),
  attachmentIds: z.array(id).max(20)
})
export const requestSchemas = {
  'window.chrome': z.object({}).strict(),
  'window.command': windowCommandSchema,
  'window.close.resolve': windowCloseResolutionSchema,
  'window.close.ready': z.object({}).strict(),
  'app.snapshot': z.object({}),
  'accounts.addImap': z.object({
    email: address,
    name: z.string().trim().min(1).max(100),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    password: z.string().min(1).max(4096),
    config: z.object({
      kind: z.literal('imap'),
      username: z.string().min(1).max(320),
      imap: endpoint,
      smtp: endpoint,
      sentCopy: z.enum(['auto', 'server', 'append'])
    })
  }),
  'accounts.oauth': z.object({
    provider: z.enum(['gmail', 'graph']),
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().max(1024).optional(),
    tenant: z
      .string()
      .regex(/^[a-zA-Z0-9.-]+$/)
      .max(253)
      .optional(),
    name: z.string().trim().min(1).max(100),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/)
  }),
  'accounts.remove': z.object({ accountId: id }),
  'accounts.update': z
    .object({
      accountId: id,
      name: z.string().trim().min(1).max(100).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      hidden: z.boolean().optional()
    })
    .strict()
    .refine(
      (value) =>
        value.name !== undefined || value.color !== undefined || value.hidden !== undefined,
      {
        message: '请至少修改一项账号设置。'
      }
    ),
  'accounts.demo': z.object({}),
  'accounts.sync': z.object({ accountId: id.optional(), full: z.boolean().optional() }),
  'messages.list': z.object({
    accountId: id.optional(),
    folderId: id.optional(),
    view: z.enum(['inbox', 'starred', 'all', 'sent', 'trash']),
    search: z.string().max(500).optional(),
    unreadOnly: z.boolean().optional(),
    cursor: z.string().max(2048).optional(),
    limit: z.number().int().min(1).max(100).default(50)
  }),
  'messages.get': z.object({ accountId: id, messageId: id }),
  'messages.cachedImages': imageScope,
  'messages.loadImages': imageScope,
  'messages.action': z
    .object({
      requestId: z.uuid(),
      accountId: id,
      messageIds: z.array(id).min(1).max(100),
      action: z.enum(['markRead', 'star', 'trash']),
      value: z.boolean().optional()
    })
    .refine((v) => v.action === 'trash' || typeof v.value === 'boolean'),
  'attachments.save': z.object({ accountId: id, messageId: id, attachmentId: id }),
  'attachments.pick': z.object({}),
  'drafts.list': z.object({}),
  'drafts.save': draft,
  'drafts.delete': z.object({ draftId: id }),
  'mail.send': draft
    .extend({ requestId: z.uuid() })
    .refine((v) => v.to.length + v.cc.length + v.bcc.length > 0, '至少填写一个收件人'),
  'operations.list': z.object({}),
  'operations.page': z
    .object({
      accountId: id.optional(),
      cursor: z.string().min(1).max(2048).optional(),
      limit: z.number().int().min(1).max(100).default(20)
    })
    .strict(),
  'sentCopies.retry': z.object({ operationId: id }),
  'operations.retry': z.object({ operationId: id })
} as const
export type Method = keyof typeof requestSchemas
export type Request<M extends Method> = z.input<(typeof requestSchemas)[M]>
export interface Responses {
  'window.chrome': WindowChromeState
  'window.command': WindowChromeState
  'window.close.resolve': void
  'window.close.ready': void
  'app.snapshot': AppSnapshot
  'accounts.addImap': Account
  'accounts.oauth': Account
  'accounts.remove': void
  'accounts.update': Account
  'accounts.demo': void
  'accounts.sync': void
  'messages.list': MessagePage
  'messages.get': MessageDetail
  'messages.cachedImages': RemoteImagesResult
  'messages.loadImages': RemoteImagesResult
  'messages.action': Operation
  'attachments.save': { saved: boolean }
  'attachments.pick': DraftAttachment[]
  'drafts.list': Draft[]
  'drafts.save': Draft
  'drafts.delete': void
  'mail.send': Operation
  'operations.list': Operation[]
  'operations.page': OperationPage
  'sentCopies.retry': void
  'operations.retry': void
}
export interface MailBridge {
  request<M extends Method>(method: M, input: Request<M>): Promise<Result<Responses[M]>>
  subscribe(listener: (event: AppEvent) => void): () => void
  platform: string
  /** Main-provided bootstrap to paint the persisted theme before the first IPC round trip. */
  initialChrome?: WindowChromeState
}
export { IPC_REQUEST, IPC_EVENT } from './channels'
export const methods = Object.keys(requestSchemas) as Method[]
export { unwrap } from './result'
