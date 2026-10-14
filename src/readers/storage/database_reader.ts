import type { Knex } from 'knex'
import { DashboardError } from '../../errors.js'
import { states } from '../../types.js'
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

export class DatabaseReader extends PublicQueueReader {
  #table: string
  #schedulesTable: string
  #schedulesAvailable = true
  constructor(
    name: string,
    adapter: PublicAdapter,
    config: AdapterConfig,
    private connection: Knex,
    redaction?: RedactionConfig,
  ) {
    super(name, adapter, config, redaction)
    this.#table =
      config.source.driver === 'database' ? (config.source.tableName ?? 'queue_jobs') : 'queue_jobs'
    this.#schedulesTable =
      config.source.driver === 'database'
        ? (config.source.schedulesTableName ?? 'queue_schedules')
        : 'queue_schedules'
    if (!/^[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?$/.test(this.#table))
      throw new Error('Invalid dashboard SQL table name')
    if (!/^[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?$/.test(this.#schedulesTable))
      throw new Error('Invalid dashboard SQL schedules table name')
    this.reason = undefined
  }
  async checkSchedulesFormat() {
    if (!this.config.schedules?.enabled) return
    try {
      await this.connection(this.#schedulesTable)
        .select(
          'id',
          'status',
          'name',
          'payload',
          'cron_expression',
          'every_ms',
          'timezone',
          'from_date',
          'to_date',
          'run_limit',
          'run_count',
          'next_run_at',
          'last_run_at',
          'created_at',
        )
        .limit(0)
    } catch (error) {
      if (
        !['42703', '42P01', 'SQLITE_ERROR', 'ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE'].includes(
          (error as { code?: string }).code ?? '',
        )
      )
        throw error
      this.#schedulesAvailable = false
      this.schedulesReason = 'SQL schedules table is missing or incompatible'
    }
  }
  async schedule(id: string) {
    this.assertSchedules()
    if (!this.#schedulesAvailable)
      return { kind: 'unsupported' as const, reason: this.schedulesReason }
    return super.schedule(id)
  }
  async schedules(input: SchedulePageInput) {
    this.assertSchedules(input)
    if (!this.capabilities().listSchedules) return super.schedules(input)
    const scope = JSON.stringify([this.name, 'schedules', input.status ?? null])
    const after = decodeCursor(input.cursor, scope)
    if (after !== undefined && (typeof after !== 'string' || after.length > 255))
      throw new DashboardError(400, 'INVALID_CURSOR', 'Invalid SQL schedule cursor')
    const query = this.connection(this.#schedulesTable)
      .whereNot('status', 'cancelled')
      .orderBy('id')
      .select('id')
      .limit(input.limit + 1)
    if (input.status) query.where('status', input.status)
    if (after !== undefined) query.where('id', '>', after)
    const rows: { id: string }[] = await query
    const ids = rows.slice(0, input.limit).map((row) => row.id)
    return available({
      items: await this.hydrateSchedules(ids, input.status),
      nextCursor: rows.length > input.limit ? encodeCursor(scope, ids.at(-1)) : undefined,
      consistency: 'live' as const,
    })
  }
  async checkFormat() {
    // Only SELECT; never migrate, fix or create indexes from the dashboard.
    await this.connection(this.#table)
      .select('id', 'queue', 'status', 'data', 'finished_at', 'error')
      .limit(0)
  }
  capabilities() {
    return {
      ...this.scheduleCapabilities(this.#schedulesAvailable),
      getSchedule: this.#schedulesAvailable && this.scheduleCapabilities(false).getSchedule,
      discoverQueues: true,
      listJobs: true,
      countsByState: true,
      getJob: true,
    }
  }
  async queues() {
    const query = this.connection(this.#table).distinct('queue').orderBy('queue').limit(1001)
    if (this.config.allowedQueues) query.whereIn('queue', this.config.allowedQueues)
    const rows: { queue: string }[] = await query
    const catalog = await super.queues()
    const configured = catalog.names
    return {
      names: [...new Set([...configured, ...rows.slice(0, 1000).map((row) => row.queue)])]
        .filter((queue) => this.allowed(queue))
        .sort(),
      origin: 'discovered' as const,
      exhaustive: rows.length <= 1000,
    }
  }
  async counts(queue: string) {
    this.assertQueue(queue)
    const rows: { status: string; total: number | string }[] = await this.connection(this.#table)
      .where('queue', queue)
      .groupBy('status')
      .select('status')
      .count('* as total')
    const counts = Object.fromEntries(states.map((state) => [state, 0])) as Counts
    for (const row of rows) {
      if (!states.includes(row.status as JobState))
        throw new DashboardError(409, 'INCOMPATIBLE_STORAGE', 'Unknown job state in queue storage')
      counts[row.status as JobState] = Number(row.total)
    }
    return available(counts)
  }
  async jobs(input: { queue: string; state: JobState; limit: number; cursor?: string }) {
    this.assertPage(input)
    const key = cursorScope(this.name, input.queue, input.state)
    const after = decodeCursor(input.cursor, key)
    if (after !== undefined && (typeof after !== 'string' || after.length > 255))
      throw new DashboardError(400, 'INVALID_CURSOR', 'Invalid SQL cursor')
    const query = this.connection(this.#table)
      .where({ queue: input.queue, status: input.state })
      .orderBy('id')
      .select('id')
      .limit(input.limit + 1)
    if (after !== undefined) query.where('id', '>', after)
    const rows: { id: string }[] = await query
    const ids = rows.slice(0, input.limit).map((row) => row.id)
    return available({
      items: await this.hydrate(input.queue, input.state, ids),
      nextCursor: rows.length > input.limit ? encodeCursor(key, ids.at(-1)) : undefined,
      consistency: 'live' as const,
    })
  }
}
