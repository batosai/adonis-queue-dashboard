import { test } from '@japa/runner'
import type { Redis } from 'ioredis'
import { PublicQueueReader } from '../../src/readers/public_queue_reader.js'
import { RedisReader } from '../../src/readers/storage/redis_reader.js'
import { encodeCursor } from '../../src/readers/cursor.js'
import type { PublicAdapter, ScheduleRecord } from '../../src/types.js'

const record = (id: string, status: ScheduleRecord['status'] = 'active'): ScheduleRecord => ({
  id,
  name: 'Digest',
  status,
  payload: { token: 'secret', nested: { text: 'secret' } },
  cronExpression: null,
  everyMs: 60000,
  timezone: 'Europe/Paris',
  from: null,
  to: null,
  limit: null,
  runCount: 0,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: new Date('2026-10-14T00:00:00Z'),
})
test.group('Schedule access and Redis pagination', () => {
  test('disabled access rejects listing and detail before touching storage', async ({ assert }) => {
    let reads = 0
    const adapter: PublicAdapter = {
      sizeOf: async () => 0,
      getJob: async () => null,
      getSchedule: async () => {
        reads++
        return record('one')
      },
    }
    const reader = new PublicQueueReader('redis', adapter, { source: { driver: 'redis' } })
    assert.isFalse(reader.capabilities().getSchedule)
    await assert.rejects(() => reader.schedule('one'), /disabled/)
    await assert.rejects(() => reader.schedules({ limit: 10 }), /disabled/)
    assert.equal(reads, 0)
  })
  test('fallback supports redacted detail, null dates and unknown IDs without queue access', async ({
    assert,
  }) => {
    const adapter: PublicAdapter = {
      sizeOf: async () => 0,
      getJob: async () => null,
      getSchedule: async (id) => (id === 'gone' ? null : record(id)),
    }
    const config = {
      source: { driver: 'redis' as const },
      schedules: { enabled: true },
      allowedQueues: [],
    }
    const reader = new PublicQueueReader('redis', adapter, config)
    assert.isFalse(reader.capabilities().listSchedules)
    assert.isTrue(reader.capabilities().getSchedule)
    const detail = await reader.schedule('one')
    if (detail.kind !== 'available') return assert.fail('Expected public schedule detail')
    assert.deepEqual(detail.value, {
      ref: { adapter: 'redis', id: 'one' },
      name: 'Digest',
      status: 'active',
      cronExpression: null,
      everyMs: 60000,
      timezone: 'Europe/Paris',
      from: null,
      to: null,
      limit: null,
      runCount: 0,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: '2026-10-14T00:00:00.000Z',
    })
    assert.notInclude(JSON.stringify(detail), 'payload')
    assert.deepEqual(
      await reader
        .schedule('gone')
        .then((result) => (result.kind === 'available' ? result.value : undefined)),
      null,
    )
    const unsupported = await reader.schedules({ limit: 10 })
    assert.equal(unsupported.kind, 'unsupported')
    await assert.rejects(() => reader.schedule('bad\n'), /ID/)
    const visible = new PublicQueueReader('redis', adapter, config, {
      showPayload: true,
      redactText: (text) => text.replaceAll('secret', '[Hidden]'),
    })
    const safe = JSON.stringify(await visible.schedule('one'))
    assert.include(safe, 'payload')
    assert.notInclude(safe, 'secret')
    const sync = new PublicQueueReader('sync', adapter, {
      source: { driver: 'sync' },
      schedules: { enabled: true },
    })
    const syncDetail = await sync.schedule('one')
    assert.equal(syncDetail.kind, 'unsupported')
  })
  test('SSCAN handles oversized batches, empty filtered pages, deleted schedules and cursor scope', async ({
    assert,
  }) => {
    const commands: string[] = []
    const adapter: PublicAdapter = {
      sizeOf: async () => 0,
      getJob: async () => null,
      getSchedule: async (id) =>
        id === 'gone' ? null : record(id, id === 'paused' ? 'paused' : 'active'),
    }
    const connection = {
      options: { keyPrefix: 'custom::' },
      type: async (key: string) => {
        commands.push(key)
        return 'set'
      },
      sscan: async (key: string) => {
        commands.push(key)
        return ['0', ['gone', 'active', 'paused']]
      },
    } as unknown as Redis
    const config = { source: { driver: 'redis' as const }, schedules: { enabled: true } }
    const reader = new RedisReader('redis', adapter, config, connection)
    const first = await reader.schedules({ status: 'paused', limit: 2 })
    if (first.kind !== 'available') return assert.fail('Expected schedule page')
    assert.isEmpty(first.value.items)
    assert.isString(first.value.nextCursor)
    const second = await reader.schedules({
      status: 'paused',
      limit: 2,
      cursor: first.value.nextCursor,
    })
    if (second.kind !== 'available') return assert.fail('Expected next page')
    assert.deepEqual(
      second.value.items.map((item) => item.ref.id),
      ['paused'],
    )
    assert.isUndefined(second.value.nextCursor)
    assert.notInclude(JSON.stringify(second), 'payload')
    await assert.rejects(
      () => reader.schedules({ status: 'active', limit: 2, cursor: first.value.nextCursor }),
      /cursor/,
    )
    const other = new RedisReader('other', adapter, config, connection)
    await assert.rejects(
      () => other.schedules({ status: 'paused', limit: 2, cursor: first.value.nextCursor }),
      /cursor/,
    )
    await assert.rejects(() => reader.schedules({ limit: 0 }), /page size/)
    await assert.rejects(
      () =>
        reader.schedules({
          limit: 1,
          cursor: encodeCursor(JSON.stringify(['redis', 'schedules', null]), {
            cursor: 'no',
            offset: -1,
          }),
        }),
      /cursor/,
    )
    assert.isTrue(commands.every((key) => key === 'schedules::index'))
  })
  test('unexpected Redis index type is rejected', async ({ assert }) => {
    const adapter: PublicAdapter = {
      sizeOf: async () => 0,
      getJob: async () => null,
      getSchedule: async () => null,
    }
    const reader = new RedisReader(
      'redis',
      adapter,
      { source: { driver: 'redis' }, schedules: { enabled: true } },
      { type: async () => 'hash' } as unknown as Redis,
    )
    await assert.rejects(() => reader.schedules({ limit: 10 }), /Unexpected Redis/)
  })
})
