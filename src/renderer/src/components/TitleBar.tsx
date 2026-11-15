import { Input } from './ui/input'
import { Search, X } from 'lucide-react'
import type { Account } from '../../../shared/model'
import type { WindowChromeState } from '../../../shared/window'
import { useUi } from '../store'
import { IconButton } from './primitives'

export function TitleBar({ accounts, chrome }: { accounts: Account[]; chrome: WindowChromeState }) {
  const { search, setSearch, view, accountId, navigate, navigationBlocked } = useUi()
  const mac = chrome.platform === 'darwin'
  return (
    <header className="titlebar" aria-label="应用标题栏">
      <div className="global-search">
        <Search size={15} aria-hidden="true" />
        <Input
          unstyled
          aria-label="搜索邮件"
          value={search}
          onChange={(event) => {
            if (view === 'drafts' || view === 'operations' || view === 'settings')
              navigate('all', accountId)
            setSearch(event.target.value)
          }}
          placeholder="搜索主题、发件人或邮件摘要"
          disabled={!accounts.length || navigationBlocked}
        />
        {search ? (
          <IconButton label="清除搜索" onClick={() => setSearch('')}>
            <X size={13} />
          </IconButton>
        ) : (
          <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>
        )}
      </div>
    </header>
  )
}
