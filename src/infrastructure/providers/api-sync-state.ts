import { randomUUID } from 'node:crypto'

interface ApiCursor {
  v: 1
  provider: 'gmail' | 'graph'
  accountId: string
  folderId: string
  base: string | null
  run?: string
  page?: number
  continuation?: string
}

export interface ApiSyncRound<Step> {
  accountId: string
  folderId: string
  base: string | null
  run: string
  page: number
  step: Step
  full: boolean
  present: Set<string>
  touched: number
}

/** Page state is disposable; every persisted page cursor retains the last committed watermark. */
export class ApiSyncRounds<Step> {
  private readonly rounds = new Map<string, ApiSyncRound<Step>>()
  constructor(private readonly provider: ApiCursor['provider']) {}

  resume(
    accountId: string,
    folderId: string,
    cursor: string | null,
    forceFull = false
  ): { round?: ApiSyncRound<Step>; base: string | null; continuation?: string } {
    if (forceFull || !cursor || cursor.length > 64 * 1024) return { base: null }
    let decoded: ApiCursor
    try {
      decoded = JSON.parse(cursor) as ApiCursor
    } catch {
      return { base: null }
    }
    if (
      !decoded ||
      decoded.v !== 1 ||
      decoded.provider !== this.provider ||
      decoded.accountId !== accountId ||
      decoded.folderId !== folderId ||
      (decoded.base !== null && (typeof decoded.base !== 'string' || !decoded.base))
    )
      return { base: null }
    const continuation =
      typeof decoded.continuation === 'string' && decoded.continuation
        ? decoded.continuation
        : undefined
    // Graph's delta is a state transition, so a partially applied round must
    // retain its native nextLink. Older cursors cannot safely replay that round
    // against local data already changed by its earlier pages.
    if (this.provider === 'graph' && decoded.run && decoded.base !== null && !continuation)
      return { base: null }
    const round = this.rounds.get(this.key(accountId, folderId))
    if (
      decoded.run &&
      round?.run === decoded.run &&
      round.page === decoded.page &&
      round.base === decoded.base &&
      Date.now() - round.touched < 30 * 60_000
    )
      return { round, base: round.base }
    // Gmail history replays its stable base. Graph continues the native round
    // after a restart or older-page replay; initial full snapshots still restart.
    return {
      base: decoded.base,
      ...(decoded.base !== null && continuation ? { continuation } : {})
    }
  }

  create(
    accountId: string,
    folderId: string,
    base: string | null,
    step: Step,
    full: boolean
  ): ApiSyncRound<Step> {
    const round: ApiSyncRound<Step> = {
      accountId,
      folderId,
      base,
      step,
      full,
      run: randomUUID(),
      page: 0,
      present: new Set(),
      touched: Date.now()
    }
    this.rounds.set(this.key(accountId, folderId), round)
    return round
  }

  next(round: ApiSyncRound<Step>, step: Step, continuation?: string): string {
    round.step = step
    round.page += 1
    round.touched = Date.now()
    return JSON.stringify({
      ...this.scope(round),
      base: round.base,
      run: round.run,
      page: round.page,
      ...(continuation ? { continuation } : {})
    })
  }

  finish(round: ApiSyncRound<Step>, stable: string): string {
    this.rounds.delete(this.key(round.accountId, round.folderId))
    return JSON.stringify({ ...this.scope(round), base: stable })
  }

  clear(): void {
    this.rounds.clear()
  }
  forgetAccount(accountId: string): void {
    for (const [key, round] of this.rounds)
      if (round.accountId === accountId) this.rounds.delete(key)
  }
  private key(accountId: string, folderId: string): string {
    return JSON.stringify([accountId, folderId])
  }
  private scope(
    round: ApiSyncRound<Step>
  ): Omit<ApiCursor, 'base' | 'run' | 'page' | 'continuation'> {
    return { v: 1, provider: this.provider, accountId: round.accountId, folderId: round.folderId }
  }
}
