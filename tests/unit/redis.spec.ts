import { test } from '@japa/runner'
import type { Redis } from 'ioredis'
import { RedisReader } from '../../src/readers/storage/redis_reader.js'
import type { PublicAdapter } from '../../src/types.js'

test.group('Redis reader command contract (no Redis server)', () => {
  test('does not claim exhaustive discovery when the catalog cap is reached', async ({
    assert,
  }) => {
    const connection = {
      options: {},
      scan: async () => [
        '0',
        Array.from({ length: 1001 }, (_, index) => `jobs::queue-${index}::data`),
      ],
    } as unknown as Redis
    const adapter: PublicAdapter = { sizeOf: async () => 0, getJob: async () => null }
    const reader = new RedisReader(
      'redis',
      adapter,
      { source: { driver: 'redis' }, queues: [] },
      connection,
    )
    const catalog = await reader.queues()
    assert.lengthOf(catalog.names, 1000)
    assert.isFalse(catalog.exhaustive)
  })
  test('discovers physical prefixed keys and bounds pages with public detail hydration', async ({
    assert,
  }) => {
    const commands: string[] = []
    const raw: PublicAdapter = {
      sizeOf: async () => 3,
      getJob: async (id) =>
        id === 'gone'
          ? null
          : { status: 'pending', data: { name: 'Job', attempts: 1, payload: null } },
    }
    const client = {
      options: { keyPrefix: 'custom::' },
      scan: async (_cursor: string, _match: string, pattern: string) => {
        assert.equal(pattern, 'custom::jobs::*::data')
        return ['0', ['custom::jobs::emails::data', 'custom::jobs::private::data']]
      },
      type: async (key: string) => {
        commands.push(`TYPE ${key}`)
        return key.endsWith('::pending') || key.endsWith('::delayed') || key.endsWith('::index')
          ? 'zset'
          : 'hash'
      },
      zcard: async () => 3,
      hlen: async () => 2,
      zrange: async (key: string, start: number, end: number) => {
        commands.push(`ZRANGE ${key}`)
        return ['a', 'gone', 'c'].slice(start, end + 1)
      },
    } as unknown as Redis
    const reader = new RedisReader(
      'redis',
      raw,
      { source: { driver: 'redis' }, queues: ['empty'], allowedQueues: ['emails', 'empty'] },
      client,
    )
    const catalog = await reader.queues()
    assert.deepEqual(catalog.names, ['emails', 'empty'])
    const first = await reader.jobs({ queue: 'emails', state: 'pending', limit: 2 })
    if (first.kind !== 'available') return assert.fail('Expected available listing')
    assert.deepEqual(
      first.value.items.map((item) => item.ref.id),
      ['a'],
    )
    assert.isString(first.value.nextCursor)
    const second = await reader.jobs({
      queue: 'emails',
      state: 'pending',
      limit: 2,
      cursor: first.value.nextCursor,
    })
    if (second.kind === 'available')
      assert.deepEqual(
        second.value.items.map((item) => item.ref.id),
        ['c'],
      )
    assert.isTrue(commands.every((command) => !command.includes('custom::')))
    await assert.rejects(() => reader.counts('private'), /not allowed/)
  })
  test('hash pages retain scan position without returning an oversized page', async ({
    assert,
  }) => {
    const raw: PublicAdapter = {
      sizeOf: async () => 0,
      getJob: async () => ({ status: 'active', data: { name: 'Job', attempts: 0, payload: null } }),
    }
    const client = {
      options: {},
      type: async () => 'none',
      hscan: async () => ['0', ['a', '{}', 'b', '{}', 'c', '{}']],
    } as unknown as Redis
    const reader = new RedisReader('redis', raw, { source: { driver: 'redis' } }, client)
    const first = await reader.jobs({ queue: 'default', state: 'active', limit: 2 })
    if (first.kind !== 'available') return assert.fail('Expected available listing')
    assert.deepEqual(
      first.value.items.map((item) => item.ref.id),
      ['a', 'b'],
    )
    const second = await reader.jobs({
      queue: 'default',
      state: 'active',
      limit: 2,
      cursor: first.value.nextCursor,
    })
    if (second.kind === 'available') {
      assert.deepEqual(
        second.value.items.map((item) => item.ref.id),
        ['c'],
      )
      assert.isUndefined(second.value.nextCursor)
    }
  })
  test('rejects storage with unexpected types', async ({ assert }) => {
    const client = { options: {}, type: async () => 'list' } as unknown as Redis
    const raw: PublicAdapter = { sizeOf: async () => 0, getJob: async () => null }
    const reader = new RedisReader('redis', raw, { source: { driver: 'redis' } }, client)
    await assert.rejects(() => reader.counts('default'), /Unexpected Redis/)
  })
})
