import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronRight, CircleHelp, Mail, Monitor, Moon, Sun } from 'lucide-react'
import type { Account } from '../../../shared/model'
import type { WindowChromeState, WindowThemePreference } from '../../../shared/window'
import { registerCloseGuard } from '../close-guards'
import { AccountPanel, type AccountUpdateHandler } from './AccountPanel'
import { HelpContent } from './HelpContent'
import { AccentColorPicker } from './AccentColorPicker'
import { DEFAULT_ACCENT_COLOR } from '../../../shared/appearance'
import { UtilityPageHeader } from './UtilityPageHeader'

const appearances = [
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'system', label: '跟随系统', icon: Monitor }
] as const

export type SettingsSection = 'general' | 'accounts' | 'help'
export interface SettingsPageProps {
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  chrome: WindowChromeState
  onTheme: (preference: WindowThemePreference) => Promise<void>
  onAccentColor?: (color: string) => Promise<void>
  themeBusy: boolean
  accounts: Account[]
  onAccountsChanged: () => void
  onAccountUpdated?: AccountUpdateHandler
  onBusyChange: (busy: boolean) => void
  initialAccountTab?: 'add' | 'manage'
  accountEntryKey?: number
}

export function SettingsPage({
  section: page,
  onSectionChange: setPage,
  chrome,
  onTheme,
  onAccentColor,
  themeBusy,
  accounts,
  onAccountsChanged,
  onAccountUpdated,
  onBusyChange,
  initialAccountTab = 'manage',
  accountEntryKey = 0
}: SettingsPageProps) {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const accountBusy = useRef(false)
  const appearanceBusy = useRef(false)
  const pageHeading = useRef<HTMLHeadingElement>(null)
  const previousPage = useRef(page)
  const publishBusy = useCallback(() => {
    const next = accountBusy.current || appearanceBusy.current
    busyRef.current = next
    setBusy(next)
    onBusyChange(next)
  }, [onBusyChange])
  const setAccountBusy = useCallback(
    (value: boolean) => {
      accountBusy.current = value
      publishBusy()
    },
    [publishBusy]
  )
  useEffect(() => {
    const unregister = registerCloseGuard(async () => !busyRef.current)
    return () => {
      unregister()
      onBusyChange(false)
    }
  }, [onBusyChange])
  useLayoutEffect(() => {
    if (previousPage.current !== page) {
      previousPage.current = page
      pageHeading.current?.focus({ preventScroll: true })
    }
  }, [page])
  async function changeTheme(preference: WindowThemePreference) {
    if (busyRef.current || themeBusy) return
    appearanceBusy.current = true
    publishBusy()
    try {
      await onTheme(preference)
    } finally {
      appearanceBusy.current = false
      publishBusy()
    }
  }
  async function changeAccentColor(color: string) {
    if (busyRef.current || themeBusy || !onAccentColor) return
    appearanceBusy.current = true
    publishBusy()
    try {
      await onAccentColor(color)
    } finally {
      appearanceBusy.current = false
      publishBusy()
    }
  }
  return (
    <main
      className="utility-view settings-view"
      aria-labelledby="settings-heading"
      aria-busy={busy || undefined}
    >
      <UtilityPageHeader
        title="设置"
        description="管理邮箱账号、应用外观与使用帮助。"
        headingId="settings-heading"
        className="settings-page-header"
      />
      <nav className="settings-section-navigation" aria-label="设置分类">
        {(
          [
            { id: 'general', label: '通用设置', icon: Monitor },
            { id: 'accounts', label: '邮箱账号', icon: Mail },
            { id: 'help', label: '使用帮助', icon: CircleHelp }
          ] as const
        ).map((item) => (
          <Button
            unstyled
            key={item.id}
            type="button"
            className={page === item.id ? 'active' : ''}
            aria-current={page === item.id ? 'page' : undefined}
            disabled={busy || themeBusy}
            onClick={() => setPage(item.id)}
          >
            <item.icon size={16} aria-hidden="true" />
            {item.label}
          </Button>
        ))}
      </nav>
      <h2 className="settings-section-title" ref={pageHeading} tabIndex={-1}>
        {page === 'general' ? '通用设置' : page === 'accounts' ? '邮箱账号' : '使用帮助'}
      </h2>
      <div className="settings-pages">
        <ScrollArea
          className="settings-page settings-scroll-area"
          viewportClassName="settings-body"
          viewportProps={{ 'aria-label': '通用设置内容', tabIndex: 0 }}
          hidden={page !== 'general'}
        >
          <section className="settings-section" aria-labelledby="settings-accounts-heading">
            <h3 id="settings-accounts-heading">邮箱账号</h3>
            <Button
              unstyled
              type="button"
              className="settings-link"
              disabled={busy}
              onClick={() => setPage('accounts')}
            >
              <span className="settings-link-icon">
                <Mail size={16} aria-hidden="true" />
              </span>
              <span className="settings-link-copy">
                <strong>管理邮箱账号</strong>
                <small>添加、修改、隐藏或移除邮箱</small>
              </span>
              <ChevronRight size={14} aria-hidden="true" />
            </Button>
          </section>
          <section className="settings-section" aria-labelledby="settings-appearance-heading">
            <div className="settings-section-heading">
              <h3 id="settings-appearance-heading">外观</h3>
              {(themeBusy || chrome.themePreference === 'system') && (
                <span>
                  {themeBusy
                    ? '正在保存…'
                    : `当前系统为${chrome.theme === 'dark' ? '深色' : '浅色'}`}
                </span>
              )}
            </div>
            <div
              className="settings-appearance"
              role="group"
              aria-labelledby="settings-appearance-heading"
              aria-busy={themeBusy || undefined}
            >
              {appearances.map((item) => {
                const selected = chrome.themePreference === item.value
                return (
                  <Button
                    unstyled
                    key={item.value}
                    type="button"
                    className={`settings-theme-option ${selected ? 'selected' : ''}`}
                    aria-pressed={selected}
                    disabled={busy || themeBusy}
                    onClick={() => {
                      if (!selected) void changeTheme(item.value)
                    }}
                  >
                    <item.icon size={17} aria-hidden="true" />
                    <span>{item.label}</span>
                    {selected && (
                      <Check size={12} className="settings-theme-check" aria-hidden="true" />
                    )}
                  </Button>
                )
              })}
            </div>
          </section>
          <section className="settings-section" aria-labelledby="settings-accent-heading">
            <h3 id="settings-accent-heading">主题色</h3>
            <AccentColorPicker
              color={chrome.accentColor || DEFAULT_ACCENT_COLOR}
              onChange={changeAccentColor}
              disabled={busy || themeBusy || !onAccentColor}
            />
          </section>
          <p className="settings-footnote">外观偏好会保存在本机。</p>
        </ScrollArea>
        <div className="settings-page settings-accounts-page" hidden={page !== 'accounts'}>
          <AccountPanel
            key={accountEntryKey}
            accounts={accounts}
            onChanged={onAccountsChanged}
            onUpdated={onAccountUpdated}
            initialTab={initialAccountTab}
            onBusyChange={setAccountBusy}
          />
        </div>
        <div className="settings-page settings-help-page" hidden={page !== 'help'}>
          <ScrollArea
            className="settings-help-scroll-area"
            viewportProps={{ 'aria-label': '使用帮助内容', tabIndex: 0 }}
          >
            <HelpContent />
          </ScrollArea>
        </div>
      </div>
    </main>
  )
}
