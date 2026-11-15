import type { Result } from './model'

/** Client-side result handling, without importing validation or host implementation. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value
  const error = new Error(result.error.message)
  Object.assign(error, result.error)
  throw error
}
