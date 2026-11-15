import type {
  DownloadedAttachment,
  MailProvider,
  OutgoingMessage,
  ProviderAction,
  ProviderSession,
  RemoteFolder,
  RemoteMessage,
  RemoteRef,
  SendReceipt,
  SentCopyResult,
  SyncPage
} from '../../core/ports'
import { MailError, type MessageBody } from '../../shared/model'
import { randomUUID } from 'node:crypto'
import { composeRaw } from './common'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

interface DemoMessage {
  summary: RemoteMessage
  body: MessageBody
  folderId: string
}
const FOLDERS: RemoteFolder[] = [
  { id: 'inbox', name: '收件箱', role: 'inbox' },
  { id: 'sent', name: '已发送', role: 'sent' },
  { id: 'drafts', name: '草稿', role: 'drafts' },
  { id: 'archive', name: '归档', role: 'archive' },
  { id: 'trash', name: '垃圾箱', role: 'trash' },
  { id: 'projects', name: '项目协作', role: 'other' }
]
const EXAMPLES = [
  [
    'Luna · Design',
    'luna@studio.example',
    'Better Mail / 新一轮界面走查',
    '新的阅读界面已经准备好了。\n\n这次我们将账号颜色放在发件人旁边，并把常用操作留在阅读区域。请重点看看长标题和较宽邮件在小窗口下的表现。\n\n周三之前反馈即可，谢谢！'
  ],
  [
    'Open Source Weekly',
    'weekly@community.example',
    '本周开源精选：让桌面工具更轻一点',
    '本周推荐几个围绕专注、离线和数据自主的项目。\n\n一个顺手的小工具，往往来自对日常流程的一次认真观察。\n\n本邮件是离线演示数据，没有订阅或外部链接。'
  ],
  [
    '陈晨',
    'chen@team.example',
    'Re: 周五找个时间聊一下？',
    '可以，周五下午三点我有空。\n\n我们可以先过一下多账号收件箱的原型，再看搜索和写信的细节。会议控制在半小时左右。\n\n到时见！'
  ],
  [
    'North Studio',
    'hello@north.example',
    '你的工作空间已经准备好',
    '欢迎来到新的工作空间。\n\n我们为你整理了项目背景、约定和入门清单。附件是一份安全的纯文本演示文件，帮助你体验附件下载。'
  ],
  [
    '城市书店',
    'books@city.example',
    '周末读书会｜把时间留给好故事',
    '本周六下午，来书店分享一本最近喜欢的书。\n\n主题没有限制，带着你的好奇心就够了。现场会准备咖啡和笔记卡。\n\n这是一封演示活动邀请。'
  ],
  [
    'Maya',
    'maya@product.example',
    'A few notes on the onboarding flow',
    'Hi there,\n\nI walked through the first-run experience and left a few notes. A clear connection status and a useful empty state will make a big difference.\n\nLet’s keep the first version focused.\n\nMaya'
  ],
  [
    '项目机器人',
    'updates@build.example',
    '构建完成 · 桌面应用预览版',
    '新的预览构建已经完成。\n\n本轮包含列表性能调整、键盘快捷键以及断网状态提示。请先体验三栏布局，再测试账号切换。\n\n此消息为演示数据，不对应实际构建。'
  ],
  [
    '林晓',
    'lin@team.example',
    '会议纪要：从收件箱到下一步',
    '今天我们确认了三个优先事项：\n\n1. 所有账号在一个收件箱中查看。\n2. 回复时清楚展示发件账号。\n3. 网络异常时保留用户正在写的内容。\n\n下次讨论搜索和归档。'
  ],
  [
    'Field Notes',
    'journal@field.example',
    'Issue 08 / A calmer digital workspace',
    'Small habits shape the tools we use.\n\nThis week: fewer interruptions, readable typography, and leaving room for the work itself.\n\nThanks for reading this sample newsletter.'
  ],
  [
    '旅途助手',
    'travel@trip.example',
    '周末出行清单已整理',
    '出门前可以再确认一下：\n\n充电器、雨伞、水杯、身份证件，以及一本适合路上读的书。\n\n这封演示邮件不含真实订单或行程。'
  ],
  [
    '财务协作',
    'finance@team.example',
    '本月费用核对说明（演示）',
    '本月的费用核对说明已经整理好。\n\n附件仅为纯文本样例，不包含任何真实账务或付款指令。你可以用它体验附件下载功能。'
  ],
  [
    'April',
    'april@creative.example',
    'Moodboard / Some quiet inspiration',
    'A little collection of ideas for the next iteration:\n\nSoft paper, generous margins, one thoughtful accent color. The interface should feel useful before it feels busy.'
  ],
  [
    '产品反馈',
    'feedback@team.example',
    '三个值得保留的小细节',
    '试用之后，有几个细节很喜欢：\n\n切换账号时筛选条件清晰；未读状态一眼可见；回复之前可以确认自己的身份。\n\n希望下一版可以增加更多快捷键。'
  ],
  [
    '周然',
    'zhou@team.example',
    '资料补充：邮件标签与文件夹',
    '补充一下今天讨论的术语：\n\n有些邮箱使用标签，同一封邮件可以出现在多个位置；另一些邮箱使用文件夹。统一界面需要保留这两者的差别。'
  ],
  [
    '阅读清单',
    'reading@notes.example',
    '留待周末：界面、文字与秩序',
    '这次的阅读主题是信息层级。\n\n标题、日期和正文之间的关系，会直接影响我们处理信息的速度。一个合适的行距，有时比多一个按钮更重要。'
  ],
  [
    '我',
    'self@example.com',
    'Re: 新项目的第一步',
    '收到，我会先做真实邮箱接入验证，再完善列表和阅读体验。\n\n第一版先覆盖核心流程，确保每次操作都能清楚知道发生在哪个账号。'
  ],
  [
    '我',
    'self@example.com',
    '界面草稿与下周安排',
    '我已经把本周的想法整理好了。\n\n下周先完成多账号切换，再处理附件和本地搜索。设计上希望更安静一点，让邮件内容成为重点。'
  ],
  [
    '团队知识库',
    'knowledge@team.example',
    '归档：开发环境配置笔记',
    '这是一份已归档的环境配置说明。\n\n旧资料仍然保留在本地，便于日后查阅。你可以从侧栏单独打开归档文件夹。'
  ],
  [
    '项目协作',
    'project@team.example',
    '设计评审 / 阅读页与写信页',
    '项目资料放在这个独立文件夹里。\n\n阅读和写信是两个核心场景：前者强调内容，后者强调收件人、发件身份和草稿状态。'
  ],
  [
    '演示通知',
    'notice@sample.example',
    '一封放在垃圾箱中的演示邮件',
    '你正在查看垃圾箱中的样例邮件。\n\n演示账号内的操作只在当前应用会话中模拟，不会连接任何邮件服务。'
  ]
] as const
const ATTACHMENT =
  'Better Mail 演示附件\n\n这是一份纯文本样例，用于验证附件预览与下载。\n不包含真实订单、付款信息或可执行内容。\n'
function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
  )
}

/** Explicit offline demonstration. No credentials, sockets, or external delivery. */
export class DemoProvider implements MailProvider {
  readonly kind = 'demo' as const
  readonly capabilities = { labels: false, archive: true, trash: true, incrementalSync: false }
  private readonly accounts = new Map<string, Map<string, DemoMessage>>()
  private readonly sentIds = new Set<string>()
  constructor(private readonly statePath?: string) {
    if (!statePath || !existsSync(statePath)) return
    try {
      if (statSync(statePath).size > 20 * 1024 * 1024) throw new Error('state too large')
      const content = readFileSync(statePath)
      if (content.length > 20 * 1024 * 1024) throw new Error('state too large')
      const state = JSON.parse(content.toString('utf8')) as {
        version: number
        accounts: [string, [string, DemoMessage][]][]
        sentIds: string[]
      }
      if (state.version !== 1 || !Array.isArray(state.accounts) || !Array.isArray(state.sentIds))
        throw new Error('invalid state')
      for (const [id, messages] of state.accounts) {
        if (
          typeof id !== 'string' ||
          !Array.isArray(messages) ||
          messages.some(
            ([key, message]) =>
              typeof key !== 'string' ||
              !message?.summary?.ref ||
              !message.body ||
              typeof message.folderId !== 'string'
          )
        )
          throw new Error('invalid message')
        this.accounts.set(id, new Map(messages))
      }
      for (const id of state.sentIds) if (typeof id === 'string') this.sentIds.add(id)
    } catch {
      throw new MailError('INTERNAL', '演示账号状态文件损坏，请备份后移除 demo-state.json 再重试')
    }
  }
  private persist(): void {
    if (!this.statePath) return
    const state = JSON.stringify({
      version: 1,
      accounts: [...this.accounts].map(([id, messages]) => [id, [...messages]]),
      sentIds: [...this.sentIds]
    })
    if (Buffer.byteLength(state) > 20 * 1024 * 1024)
      throw new MailError('UNSUPPORTED', '演示数据已超过 20 MiB，请清理演示账号')
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, state, { mode: 0o600 })
      renameSync(temporary, this.statePath)
    } catch {
      try {
        unlinkSync(temporary)
      } catch {
        /* Already renamed or never created. */
      }
      throw new MailError('INTERNAL', '无法保存演示状态，请检查本地磁盘权限和空间')
    }
  }
  private messages(session: ProviderSession): Map<string, DemoMessage> {
    if (
      session.config.kind !== 'demo' ||
      !['demo@example.com', 'work@example.com'].includes(session.account.email)
    )
      throw new MailError('VALIDATION', '演示模式仅支持明确标记的示例账号')
    const existing = this.accounts.get(session.account.id)
    if (existing) return existing
    const map = new Map<string, DemoMessage>()
    const work = session.account.email === 'work@example.com'
    EXAMPLES.forEach(([name, from, subject, text], index) => {
      const id = `demo-${index + 1}`
      const folderId =
        index < 15
          ? 'inbox'
          : index < 17
            ? 'sent'
            : index === 17
              ? 'archive'
              : index === 18
                ? 'projects'
                : 'trash'
      const hasAttachments = index === 3 || index === 10
      const body: MessageBody = {
        text,
        html: `<div><p>${text
          .split('\n\n')
          .map((paragraph) => escape(paragraph).replace(/\n/g, '<br>'))
          .join('</p><p>')}</p></div>`,
        attachments: hasAttachments
          ? [
              {
                id: 'sample-text',
                filename: index === 3 ? '欢迎与入门.txt' : '费用说明-演示.txt',
                contentType: 'text/plain',
                size: Buffer.byteLength(ATTACHMENT)
              }
            ]
          : []
      }
      map.set(id, {
        folderId,
        body,
        summary: {
          remoteId: id,
          ref: { id, folderId },
          subject:
            work && index < 3
              ? [
                  '项目周报 / 本周进展与接下来的安排',
                  '关于多账号工作流的一点反馈',
                  '周五的产品同步会议'
                ][index]!
              : subject,
          from: [
            {
              name: folderId === 'sent' ? session.account.name : name,
              address: folderId === 'sent' ? session.account.email : from
            }
          ],
          to: [{ address: folderId === 'sent' ? 'team@studio.example' : session.account.email }],
          date: Date.now() - (index * 3 + (work ? 2 : 0)) * 60 * 60 * 1000,
          snippet: text.replace(/\s+/g, ' ').slice(0, 150),
          isRead: index > 4,
          isStarred: [0, 5, 12].includes(index),
          hasAttachments,
          internetMessageId: `<${session.account.id}.${id}@demo.better-mail.local>`
        }
      })
    })
    this.accounts.set(session.account.id, map)
    this.persist()
    return map
  }
  async testConnection(session: ProviderSession): Promise<void> {
    this.messages(session)
  }
  async listFolders(session: ProviderSession): Promise<RemoteFolder[]> {
    this.messages(session)
    return FOLDERS.map((folder) => ({ ...folder }))
  }
  async syncFolder(
    session: ProviderSession,
    folder: RemoteFolder,
    _cursor: string | null
  ): Promise<SyncPage> {
    const messages = [...this.messages(session).values()]
      .filter((message) => message.folderId === folder.id)
      .map((message) => structuredClone(message.summary))
    return {
      messages,
      removedIds: [],
      cursor: null,
      hasMore: false,
      presentIds: messages.map((message) => message.remoteId),
      reset: true
    }
  }
  async fetchBody(session: ProviderSession, ref: RemoteRef): Promise<MessageBody> {
    const message = this.messages(session).get(ref.id)
    if (!message) throw new MailError('NOT_FOUND', '演示邮件不存在')
    return structuredClone(message.body)
  }
  async fetchAttachment(
    session: ProviderSession,
    ref: RemoteRef,
    attachmentId: string
  ): Promise<DownloadedAttachment> {
    const body = await this.fetchBody(session, ref)
    const attachment = body.attachments.find((item) => item.id === attachmentId)
    if (!attachment) throw new MailError('NOT_FOUND', '演示附件不存在')
    return {
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: Buffer.from(ATTACHMENT, 'utf8')
    }
  }
  async applyAction(session: ProviderSession, action: ProviderAction): Promise<void> {
    const message = this.messages(session).get(action.ref.id)
    if (!message) throw new MailError('NOT_FOUND', '演示邮件不存在')
    if (action.kind === 'markRead') message.summary.isRead = !!action.value
    if (action.kind === 'star') message.summary.isStarred = !!action.value
    if (action.kind === 'trash') {
      message.folderId = 'trash'
      message.summary.ref.folderId = 'trash'
    }
    this.persist()
  }
  async prepareSend(message: OutgoingMessage): Promise<Uint8Array> {
    return composeRaw(message)
  }
  async send(
    session: ProviderSession,
    message: OutgoingMessage,
    _prepared?: Uint8Array
  ): Promise<SendReceipt> {
    const messages = this.messages(session)
    const key = `${session.account.id}:${message.messageId}`
    const id = `sent-${message.messageId}`
    if (this.sentIds.has(key)) return { remoteId: id, ref: { id, folderId: 'sent' } }
    messages.set(id, {
      folderId: 'sent',
      summary: {
        remoteId: id,
        ref: { id, folderId: 'sent' },
        subject: message.subject || '(无主题)',
        from: [{ name: session.account.name, address: session.account.email }],
        to: message.to.map((address) => ({ address })),
        date: message.date ?? Date.now(),
        snippet: `[仅演示，未实际发送] ${message.text.slice(0, 120)}`,
        isRead: true,
        isStarred: false,
        hasAttachments: false,
        internetMessageId: message.messageId
      },
      body: {
        text: `这封邮件仅在演示模式中模拟，未实际发送。\n\n${message.text}`,
        html: null,
        attachments: []
      }
    })
    this.sentIds.add(key)
    this.persist()
    return { remoteId: id, ref: { id, folderId: 'sent' } }
  }
  async saveSentCopy(
    session: ProviderSession,
    message: OutgoingMessage,
    _raw: Uint8Array,
    _options: { verifyOnly: boolean; receipt?: SendReceipt }
  ): Promise<SentCopyResult> {
    const exact = [...this.messages(session).values()].find(
      (item) => item.folderId === 'sent' && item.summary.internetMessageId === message.messageId
    )
    return exact
      ? { state: 'saved', ref: structuredClone(exact.summary.ref) }
      : { state: 'missing' }
  }
  async dispose(): Promise<void> {
    this.accounts.clear()
    this.sentIds.clear()
  }
  async disconnectAccount(accountId: string): Promise<void> {
    this.accounts.delete(accountId)
    for (const key of this.sentIds) if (key.startsWith(`${accountId}:`)) this.sentIds.delete(key)
    this.persist()
  }
}
