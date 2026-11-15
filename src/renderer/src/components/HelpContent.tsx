import { ShieldCheck } from 'lucide-react'
import { BrandMark } from './BrandMark'

export function HelpContent() {
  return (
    <div className="help-content">
      <div className="help-brand">
        <BrandMark />
        <span>让邮件回归简单。</span>
      </div>
      <p>
        在统一收件箱查看所有账号，也可以在左侧选择单个邮箱。右键邮件，可以快速标记已读、添加星标或移到垃圾箱。
      </p>
      <div className="shortcut-row">
        <span>写邮件</span>
        <span>
          <kbd>⌘ / Ctrl</kbd>
          <kbd>N</kbd>
        </span>
      </div>
      <div className="shortcut-row">
        <span>搜索邮件</span>
        <span>
          <kbd>⌘ / Ctrl</kbd>
          <kbd>K</kbd>
        </span>
      </div>
      <div className="shortcut-row">
        <span>关闭弹窗</span>
        <kbd>Esc</kbd>
      </div>
      <div className="privacy-note">
        <ShieldCheck size={19} />
        <span>
          邮件缓存与草稿保存在本机；应用运行时直接与邮箱服务商同步。演示账号不会真实发送邮件。
        </span>
      </div>
      <p className="muted">
        添加真实邮箱前，请开启 IMAP/SMTP 或配置对应的 OAuth
        应用。连接异常与待确认的发送结果，请在账号设置和操作队列中查看。
      </p>
    </div>
  )
}
