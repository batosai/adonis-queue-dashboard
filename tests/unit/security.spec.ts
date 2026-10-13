import { test } from '@japa/runner'
import { defineConfig } from '../../src/define_config.js'
import { Redactor } from '../../src/security/redactor.js'
import { decodeCursor, encodeCursor } from '../../src/readers/cursor.js'
import { PublicQueueReader } from '../../src/readers/public_queue_reader.js'
import type { PublicAdapter } from '../../src/types.js'

test.group('Security and public fallback', () => {
  test('validates reader configuration without prescribing a host access policy', ({ assert }) => {
    assert.throws(
      () => defineConfig({ adapters: {}, redaction: { showPayload: true } }),
      /redactText/,
    )
    assert.deepEqual(defineConfig({ adapters: {} }).adapters, {})
  })
  test('redacts nested keys, text and circular or oversized payloads', ({ assert }) => {
    const redactor = new Redactor({
      sensitiveKeys: ['custom'],
      redactText: (value) => value.replaceAll('bare-secret', '[Hidden]'),
      maxDepth: 2,
    })
    const circular: Record<string, unknown> = {
      token: 'bare-secret',
      text: 'bare-secret',
      nested: { api_key: 'secret', customField: 'secret' },
    }
    circular.circular = circular
    const safe = JSON.stringify(redactor.payload(circular))
    assert.notInclude(safe, 'bare-secret')
    assert.notInclude(safe, '"secret"')
    assert.include(safe, '[Circular]')
    assert.notInclude(new Redactor().text('sensitive-error'), 'sensitive-error')
  })
  test('rejects malformed and cross-queue cursors', ({ assert }) => {
    assert.throws(() => decodeCursor('bad!', 'one'), /cursor/)
    assert.throws(() => decodeCursor(encodeCursor('one', 1), 'two'), /cursor/)
  })
  test('fallback keeps pending count and details but no fabricated totals', async ({ assert }) => {
    const raw: PublicAdapter = {
      sizeOf: async () => 7,
      getJob: async () => ({
        status: 'failed',
        data: { name: 'EmailJob', attempts: 2, payload: { password: 'secret' } },
        error: 'secret',
      }),
    }
    const reader = new PublicQueueReader('sql', raw, {
      source: { driver: 'database' },
      allowedQueues: ['emails'],
    })
    assert.deepEqual(await reader.queues(), { names: [], origin: 'configured', exhaustive: false })
    const pending = await reader.pendingCount('emails')
    assert.equal(pending.kind, 'available')
    const counts = await reader.counts('emails')
    assert.equal(counts.kind, 'unsupported')
    const detail = await reader.job('emails', 'one')
    assert.equal(detail.kind, 'available')
    assert.notInclude(JSON.stringify(detail), '"secret"')
    assert.notInclude(JSON.stringify(detail), 'payload')
    await assert.rejects(() => reader.counts('private'), /not allowed/)
  })
})
