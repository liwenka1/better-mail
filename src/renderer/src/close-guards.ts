export type CloseGuard = () => Promise<boolean>
const guards = new Set<CloseGuard>()
let checking: Promise<boolean> | null = null

/** Each renderer coordinates its mounted editors before its host window may close. */
export function registerCloseGuard(guard: CloseGuard): () => void {
  guards.add(guard)
  return () => {
    guards.delete(guard)
  }
}

export function runCloseGuards(): Promise<boolean> {
  if (checking) return checking
  const check = (async () => {
    for (const guard of [...guards]) {
      if (!guards.has(guard)) continue
      try {
        if (!(await guard())) return false
      } catch {
        return false
      }
    }
    return true
  })()
  checking = check
  void check.finally(() => {
    if (checking === check) checking = null
  })
  return check
}
