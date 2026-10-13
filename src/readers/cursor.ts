import { DashboardError } from '../errors.js'
import type { JobState } from '../types.js'

export function encodeCursor(scope: string, value: unknown) {
  return Buffer.from(JSON.stringify({ scope, value })).toString('base64url')
}
export function decodeCursor(cursor: string | undefined, scope: string): unknown {
  if (!cursor) return undefined
  try {
    if (cursor.length > 4096 || !/^[\w-]+$/.test(cursor)) throw new Error('Invalid encoding')
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (decoded.scope !== scope) throw new Error('Invalid scope')
    return decoded.value
  } catch {
    throw new DashboardError(400, 'INVALID_CURSOR', 'Invalid pagination cursor')
  }
}
export function cursorScope(adapter: string, queue: string, state: JobState) {
  return JSON.stringify([adapter, queue, state])
}
