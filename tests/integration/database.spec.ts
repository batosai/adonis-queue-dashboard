import { test } from '@japa/runner'
import knex from 'knex'
import { KnexAdapter } from '@boringnode/queue/drivers/knex_adapter'
import { QueueSchemaService, jobLease } from '../helpers/queue.js'
import { DatabaseReader } from '../../src/readers/storage/database_reader.js'

test.group('Database reader on real SQLite storage', () => {
  test('a completed job is invisible after default deletion, but visible with explicit retention', async ({
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
      const reader = new DatabaseReader('sql', adapter, { source: { driver: 'database' } }, db)
      await adapter.pushOn('emails', {
        id: 'removed-mail',
        name: 'SendMail',
        attempts: 0,
        payload: null,
      })
      const removedJob = await adapter.popFrom('emails')
      await adapter.completeJob(jobLease(removedJob!), 'emails')
      const removed = await reader.jobs({ queue: 'emails', state: 'completed', limit: 10 })
      if (removed.kind !== 'available') return assert.fail('Expected available listing')
      assert.isEmpty(removed.value.items)
      await adapter.pushOn('emails', {
        id: 'retained-mail',
        name: 'SendMail',
        attempts: 0,
        payload: null,
      })
      const retainedJob = await adapter.popFrom('emails')
      await adapter.completeJob(jobLease(retainedJob!), 'emails', { count: 200 })
      const retained = await reader.jobs({ queue: 'emails', state: 'completed', limit: 10 })
      if (retained.kind !== 'available') return assert.fail('Expected available listing')
      assert.deepEqual(
        retained.value.items.map((item) => item.ref.id),
        ['retained-mail'],
      )
    } finally {
      await db.destroy()
    }
  })
  test('counts and paginates retained states without writing; honors custom table and allowlist', async ({
    assert,
  }) => {
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    })
    try {
      await new QueueSchemaService(db).createJobsTable('custom_jobs')
      const adapter = new KnexAdapter({ connection: db, tableName: 'custom_jobs' })
      for (const id of ['a', 'b', 'c'])
        await adapter.pushOn('emails', {
          id,
          name: 'EmailJob',
          attempts: 0,
          payload: { password: 'hidden' },
        })
      await adapter.pushLaterOn(
        'emails',
        { id: 'delayed', name: 'EmailJob', attempts: 0, payload: null },
        60000,
      )
      await adapter.pushOn('private', {
        id: 'private',
        name: 'PrivateJob',
        attempts: 0,
        payload: null,
      })
      const first = await adapter.popFrom('emails')
      await adapter.completeJob(jobLease(first!), 'emails', false)
      const second = await adapter.popFrom('emails')
      await adapter.failJob(jobLease(second!), 'emails', new Error('sensitive-password'), false)
      const reader = new DatabaseReader(
        'sql',
        adapter,
        {
          source: { driver: 'database', tableName: 'custom_jobs' },
          queues: ['empty'],
          allowedQueues: ['emails', 'empty'],
        },
        db,
      )
      await reader.checkFormat()
      const queries: string[] = []
      const listener = (query: { sql: string }) => queries.push(query.sql)
      db.on('query', listener)
      const counts = await reader.counts('emails')
      assert.equal(counts.kind, 'available')
      if (counts.kind === 'available')
        assert.deepEqual(counts.value, {
          pending: 1,
          delayed: 1,
          active: 0,
          completed: 1,
          failed: 1,
        })
      const catalog = await reader.queues()
      assert.deepEqual(catalog.names, ['emails', 'empty'])
      const failed = await reader.jobs({ queue: 'emails', state: 'failed', limit: 1 })
      assert.equal(failed.kind, 'available')
      assert.notInclude(JSON.stringify(failed), 'sensitive-password')
      assert.notInclude(JSON.stringify(failed), 'payload')
      const before = await db('custom_jobs').select('*').orderBy('id')
      await reader.jobs({ queue: 'emails', state: 'pending', limit: 1 })
      assert.deepEqual(await db('custom_jobs').select('*').orderBy('id'), before)
      assert.isTrue(
        queries.every((sql) => /^select\b/i.test(sql)),
        queries.join('\n'),
      )
      await assert.rejects(() => reader.counts('private'), /not allowed/)
      db.off('query', listener)
    } finally {
      await db.destroy()
    }
  })
  test('keyset pages tolerate a job removed between pages and keep queue scope', async ({
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
      for (const id of ['a', 'b', 'c', 'd'])
        await adapter.push({ id, name: 'Job', attempts: 0, payload: null })
      const reader = new DatabaseReader('sql', adapter, { source: { driver: 'database' } }, db)
      const first = await reader.jobs({ queue: 'default', state: 'pending', limit: 2 })
      assert.equal(first.kind, 'available')
      if (first.kind !== 'available') return
      assert.deepEqual(
        first.value.items.map((item) => item.ref.id),
        ['a', 'b'],
      )
      await db('queue_jobs').where('id', 'c').delete()
      const next = await reader.jobs({
        queue: 'default',
        state: 'pending',
        limit: 2,
        cursor: first.value.nextCursor,
      })
      if (next.kind === 'available')
        assert.deepEqual(
          next.value.items.map((item) => item.ref.id),
          ['d'],
        )
      await assert.rejects(
        () =>
          reader.jobs({
            queue: 'other',
            state: 'pending',
            limit: 2,
            cursor: first.value.nextCursor,
          }),
        /cursor/,
      )
      const unknown = await reader.job('default', 'missing')
      if (unknown.kind === 'available') assert.isNull(unknown.value)
    } finally {
      await db.destroy()
    }
  })
})
