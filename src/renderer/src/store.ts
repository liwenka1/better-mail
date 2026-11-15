import { create } from 'zustand'
import type { MailFolder } from '../../shared/model'
export type View =
  'inbox' | 'starred' | 'all' | 'sent' | 'trash' | 'drafts' | 'operations' | 'settings'
export type ReadFilter = 'all' | 'unread'

function correspondingFolder(
  previous: MailFolder | undefined,
  accountId: string | undefined,
  folders: readonly MailFolder[]
): MailFolder | undefined {
  if (!previous || !accountId) return undefined
  const candidates = folders.filter(
    (folder) => folder.accountId === accountId && folder.role === previous.role
  )
  const matchingNames = candidates.filter(
    (folder) => folder.name.toLowerCase() === previous.name.toLowerCase()
  )
  if (previous.role === 'other') return matchingNames.length === 1 ? matchingNames[0] : undefined
  return matchingNames[0] || candidates[0]
}

interface UiState {
  accountId?: string
  folderId?: string
  view: View
  search: string
  readFilter: ReadFilter
  selected: { accountId: string; id: string } | null
  readRequested: boolean
  navigationBlocked: boolean
  setNavigationBlocked: (blocked: boolean) => void
  navigate: (view: View, accountId?: string, folderId?: string) => void
  switchAccount: (accountId?: string, folders?: readonly MailFolder[]) => void
  select: (selected: UiState['selected']) => void
  preview: (selected: UiState['selected']) => void
  setSearch: (search: string) => void
  setReadFilter: (filter: ReadFilter) => void
}
export const useUi = create<UiState>((set) => ({
  view: 'inbox',
  search: '',
  readFilter: 'all',
  selected: null,
  readRequested: false,
  navigationBlocked: false,
  setNavigationBlocked: (navigationBlocked) => set({ navigationBlocked }),
  navigate: (view, accountId, folderId) =>
    set((state) =>
      state.navigationBlocked ||
      (state.view === view && state.accountId === accountId && state.folderId === folderId)
        ? state
        : {
            view,
            accountId,
            folderId,
            selected: null,
            readRequested: false,
            search: '',
            readFilter: 'all'
          }
    ),
  switchAccount: (accountId, folders = []) =>
    set((state) => {
      if (state.navigationBlocked || state.accountId === accountId) return state
      const previousFolder = folders.find(
        (folder) => folder.id === state.folderId && folder.accountId === state.accountId
      )
      const counterpart = correspondingFolder(previousFolder, accountId, folders)
      return {
        accountId,
        folderId: counterpart?.id,
        selected: null,
        readRequested: false
      }
    }),
  select: (selected) =>
    set((state) =>
      state.selected?.id === selected?.id &&
      state.selected?.accountId === selected?.accountId &&
      state.readRequested === Boolean(selected)
        ? state
        : { selected, readRequested: Boolean(selected) }
    ),
  preview: (selected) =>
    set((state) =>
      state.selected?.id === selected?.id && state.selected?.accountId === selected?.accountId
        ? state
        : { selected, readRequested: false }
    ),
  setSearch: (search) =>
    set((state) =>
      state.navigationBlocked || state.search === search
        ? state
        : { search, selected: null, readRequested: false }
    ),
  setReadFilter: (readFilter) =>
    set((state) => (state.readFilter === readFilter ? state : { readFilter }))
}))
