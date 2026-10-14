import { test } from '@japa/runner'
import knex from 'knex'
import { KnexAdapter } from '@boringnode/queue/drivers/knex_adapter'
import { QueueSchemaService } from '@boringnode/queue'
import { DatabaseReader } from '../../src/readers/storage/database_reader.js'

test.group('Schedules on real SQLite storage', () => {
  test('custom table pagination, status filters, every field, redaction and read-only queries', async ({
    assert,
  }) => {
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    })
    try {
      await new QueueSchemaService(db).createSchedulesTable('custom_schedules')
      const adapter = new KnexAdapter({ connection: db, schedulesTableName: 'custom_schedules' })
      for (const id of ['a', 'b', 'c'])
        await adapter.upsertSchedule({
          id,
          name: 'Digest',
          payload: { token: 'hidden-secret', text: 'hidden-secret' },
          cronExpression: '0 8 * * *',
          timezone: 'Europe/Paris',
          from: new Date('2026-01-01Z'),
          to: new Date('2027-01-01Z'),
          limit: 3,
        })
      await adapter.updateSchedule('b', {
        status: 'paused',
        runCount: 2,
        lastRunAt: new Date('2026-10-13T08:00:00Z'),
        nextRunAt: new Date('2026-10-15T06:00:00Z'),
      })
      await adapter.updateSchedule('c', { runCount: 3, nextRunAt: null })
      const config = {
        source: { driver: 'database' as const, schedulesTableName: 'custom_schedules' },
        schedules: { enabled: true },
        allowedQueues: [],
      }
      const reader = new DatabaseReader('sql', adapter, config, db, {
        showPayload: true,
        redactText: (text) => text.replaceAll('hidden-secret', '[Hidden]'),
      })
      const before = await db('custom_schedules').select('*').orderBy('id')
      const queries: string[] = []
      db.on('query', (query: { sql: string }) => queries.push(query.sql))
      await reader.checkSchedulesFormat()
      const first = await reader.schedules({ limit: 1 })
      if (first.kind !== 'available') return assert.fail('Expected page')
      assert.deepEqual(
        first.value.items.map((item) => item.ref.id),
        ['a'],
      )
      const second = await reader.schedules({ limit: 1, cursor: first.value.nextCursor })
      if (second.kind !== 'available') return assert.fail('Expected page')
      const detail = second.value.items[0]!
      assert.equal(detail.ref.id, 'b')
      assert.equal(detail.status, 'paused')
      assert.equal(detail.runCount, 2)
      assert.equal(detail.limit, 3)
      assert.equal(detail.from, '2026-01-01T00:00:00.000Z')
      assert.equal(detail.to, '2027-01-01T00:00:00.000Z')
      assert.equal(detail.lastRunAt, '2026-10-13T08:00:00.000Z')
      assert.equal(detail.timezone, 'Europe/Paris')
      assert.equal(detail.cronExpression, '0 8 * * *')
      assert.isNull(detail.everyMs)
      assert.isString(detail.nextRunAt)
      assert.isString(detail.createdAt)
      assert.notInclude(JSON.stringify(detail), 'hidden-secret')
      const filtered = await reader.schedules({ status: 'paused', limit: 10 })
      if (filtered.kind === 'available')
        assert.deepEqual(
          filtered.value.items.map((item) => item.ref.id),
          ['b'],
        )
      const ended = await reader.schedule('c')
      if (ended.kind === 'available') {
        assert.equal(ended.value!.status, 'active')
        assert.isNull(ended.value!.nextRunAt)
      }
      await assert.rejects(
        () => reader.schedules({ status: 'active', limit: 1, cursor: first.value.nextCursor }),
        /cursor/,
      )
      assert.deepEqual(await db('custom_schedules').select('*').orderBy('id'), before)
      assert.isTrue(
        queries.every((sql) => /^select\b/i.test(sql)),
        queries.join('\n'),
      )
      await db('custom_schedules').where('id', 'b').delete()
      const moved = await reader.schedules({ limit: 1, cursor: first.value.nextCursor })
      if (moved.kind === 'available')
        assert.deepEqual(
          moved.value.items.map((item) => item.ref.id),
          ['c'],
        )
    } finally {
      await db.destroy()
    }
  })
  test('missing or incompatible schedules table preserves jobs and disables both schedule endpoints', async ({
    assert,
  }) => {
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    })
    try {
      await new QueueSchemaService(db).createJobsTable()
      const adapter = new KnexAdapter({ connection: db })
      await adapter.push({ id: 'job', name: 'Digest', attempts: 0, payload: null })
      for (const table of ['missing', 'incompatible']) {
        if (table === 'incompatible')
          await db.schema.createTable(table, (builder) => builder.string('id'))
        const reader = new DatabaseReader(
          'sql',
          adapter,
          {
            source: { driver: 'database', schedulesTableName: table },
            schedules: { enabled: true },
          },
          db,
        )
        await reader.checkFormat()
        await reader.checkSchedulesFormat()
        assert.isTrue(reader.capabilities().listJobs)
        assert.isFalse(reader.capabilities().listSchedules)
        assert.isFalse(reader.capabilities().getSchedule)
        const unsupportedDetail = await reader.schedule('anything')
        assert.equal(unsupportedDetail.kind, 'unsupported')
        const unsupported = await reader.schedules({ limit: 10 })
        assert.equal(unsupported.kind, 'unsupported')
        const jobs = await reader.jobs({ queue: 'default', state: 'pending', limit: 10 })
        if (jobs.kind === 'available') assert.lengthOf(jobs.value.items, 1)
      }
    } finally {
      await db.destroy()
    }
  })
})
