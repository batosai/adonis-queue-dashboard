import type { Redis } from 'ioredis'
import { DashboardError } from '../../errors.js'
import type {
  AdapterConfig,
  Counts,
  JobState,
  PublicAdapter,
  RedactionConfig,
  SchedulePageInput,
} from '../../types.js'
import { PublicQueueReader, available } from '../public_queue_reader.js'
import { decodeCursor, encodeCursor, cursorScope } from '../cursor.js'

const globEscape = (value: string) => value.replace(/[\\*?\[\]]/g, '\\$&')
export class RedisReader extends PublicQueueReader {
  #scanCursor = '0'
  #discovered = new Set<string>()
  #complete = false
  #limited = false
  #lastScan = 0
  constructor(
    name: string,
    adapter: PublicAdapter,
    config: AdapterConfig,
    private connection: Redis,
    redaction?: RedactionConfig,
  ) {
    super(name, adapter, config, redaction)
    this.reason = undefined
  }
  capabilities() {
    return {
      ...this.scheduleCapabilities(true),
      discoverQueues: true,
      listJobs: true,
      countsByState: true,
      getJob: true,
    }
  }
  async schedules(input: SchedulePageInput) {
    this.assertSchedules(input)
    if (!this.capabilities().listSchedules) return super.schedules(input)
    const type = await this.connection.type('schedules::index')
    if (type !== 'none' && type !== 'set')
      throw new DashboardError(
        409,
        'INCOMPATIBLE_STORAGE',
        'Unexpected Redis schedules storage type',
      )
    const scope = JSON.stringify([this.name, 'schedules', input.status ?? null])
    const value = decodeCursor(input.cursor, scope)
    const scan =
      value === undefined
        ? { cursor: '0', offset: 0 }
        : (value as { cursor: string; offset: number })
    if (
      !scan ||
      !/^\d{1,20}$/.test(scan.cursor) ||
      !Number.isInteger(scan.offset) ||
      scan.offset < 0 ||
      scan.offset > 100000
    )
      throw new DashboardError(400, 'INVALID_CURSOR', 'Invalid Redis schedule cursor')
    const [cursor, batch] = await this.connection.sscan(
      'schedules::index',
      scan.cursor,
      'COUNT',
      input.limit,
    )
    const ids = [...new Set(batch.slice(scan.offset, scan.offset + input.limit))]
    const nextCursor =
      batch.length > scan.offset + input.limit
        ? encodeCursor(scope, { cursor: scan.cursor, offset: scan.offset + input.limit })
        : cursor !== '0'
          ? encodeCursor(scope, { cursor, offset: 0 })
          : undefined
    return available({
      items: await this.hydrateSchedules(ids, input.status),
      nextCursor,
      consistency: 'live' as const,
    })
  }
  #key(queue: string, suffix: string) {
    return `jobs::${queue}::${suffix}`
  }
  async queues() {
    // SCAN returns physical keys; ioredis does not prefix its MATCH argument.
    const prefix = this.connection.options.keyPrefix ?? ''
    if (Date.now() - this.#lastScan > 5000) {
      if (this.#complete) {
        this.#scanCursor = '0'
        this.#discovered.clear()
        this.#complete = false
        this.#limited = false
      }
      for (let page = 0; page < 5; page++) {
        const [cursor, keys] = await this.connection.scan(
          this.#scanCursor,
          'MATCH',
          `${globEscape(prefix)}jobs::*::data`,
          'COUNT',
          200,
        )
        this.#scanCursor = cursor
        for (const physicalKey of keys) {
          const queue = physicalKey.slice(prefix.length + 'jobs::'.length, -'::data'.length)
          if (queue && this.allowed(queue) && !this.#discovered.has(queue)) {
            if (this.#discovered.size < 1000) this.#discovered.add(queue)
            else this.#limited = true
          }
        }
        if (cursor === '0') {
          this.#complete = true
          break
        }
        if (this.#discovered.size >= 1000) break
      }
      this.#lastScan = Date.now()
    }
    const configured = await super.queues()
    return {
      names: [...new Set([...configured.names, ...this.#discovered])].sort(),
      origin: 'discovered' as const,
      exhaustive: this.#complete && !this.#limited,
    }
  }
  async #checkFormat(queue: string) {
    const expected = {
      pending: 'zset',
      delayed: 'zset',
      active: 'hash',
      completed: 'hash',
      failed: 'hash',
      'completed::index': 'zset',
      'failed::index': 'zset',
      data: 'hash',
    }
    for (const [suffix, type] of Object.entries(expected)) {
      const actual = await this.connection.type(this.#key(queue, suffix))
      if (actual !== 'none' && actual !== type)
        throw new DashboardError(409, 'INCOMPATIBLE_STORAGE', 'Unexpected Redis queue storage type')
    }
  }
  async counts(queue: string) {
    this.assertQueue(queue)
    await this.#checkFormat(queue)
    const values = await Promise.all([
      this.connection.zcard(this.#key(queue, 'pending')),
      this.connection.zcard(this.#key(queue, 'delayed')),
      this.connection.hlen(this.#key(queue, 'active')),
      this.connection.hlen(this.#key(queue, 'completed')),
      this.connection.hlen(this.#key(queue, 'failed')),
    ])
    return available(
      Object.fromEntries(
        ['pending', 'delayed', 'active', 'completed', 'failed'].map((state, index) => [
          state,
          values[index],
        ]),
      ) as Counts,
    )
  }
  async jobs(input: { queue: string; state: JobState; limit: number; cursor?: string }) {
    this.assertPage(input)
    await this.#checkFormat(input.queue)
    const key = cursorScope(this.name, input.queue, input.state)
    const value = decodeCursor(input.cursor, key)
    let ids: string[]
    let nextCursor: string | undefined
    if (input.state === 'active') {
      // Cursor also keeps an offset within a scan batch. Re-reading the same batch
      // avoids putting potentially thousands of job IDs in a browser cursor.
      const scan =
        value === undefined
          ? { cursor: '0', offset: 0 }
          : (value as { cursor: string; offset: number })
      if (
        !scan ||
        !/^\d{1,20}$/.test(scan.cursor) ||
        !Number.isInteger(scan.offset) ||
        scan.offset < 0 ||
        scan.offset > 100000
      )
        throw new DashboardError(400, 'INVALID_CURSOR', 'Invalid Redis hash cursor')
      const [cursor, fields] = await this.connection.hscan(
        this.#key(input.queue, 'active'),
        scan.cursor,
        'COUNT',
        input.limit,
      )
      const batch = fields.filter((_, index) => index % 2 === 0)
      ids = [...new Set(batch.slice(scan.offset, scan.offset + input.limit))]
      if (batch.length > scan.offset + input.limit)
        nextCursor = encodeCursor(key, { cursor: scan.cursor, offset: scan.offset + input.limit })
      else if (cursor !== '0') nextCursor = encodeCursor(key, { cursor, offset: 0 })
    } else {
      const offset = value ?? 0
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)
        throw new DashboardError(400, 'INVALID_CURSOR', 'Invalid Redis sorted-set cursor')
      const suffix =
        input.state === 'completed' || input.state === 'failed'
          ? `${input.state}::index`
          : input.state
      const batch = await this.connection.zrange(
        this.#key(input.queue, suffix),
        offset,
        offset + input.limit,
      )
      ids = batch.slice(0, input.limit)
      if (batch.length > input.limit) nextCursor = encodeCursor(key, offset + input.limit)
    }
    return available({
      items: await this.hydrate(input.queue, input.state, ids),
      nextCursor,
      consistency: 'live' as const,
    })
  }
}
