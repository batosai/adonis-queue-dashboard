import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/http-server/factories'

test('schedule POST actions use native Queue API, honor limits and enforce access', async ({
  assert,
}) => {
  const { createDemo } = await import(new URL('../../examples/demo/app.mjs', import.meta.url).href)
  for (const readOnly of [false, true]) {
    const { app, server } = await createDemo({ password: 'action-test', readOnly })
    try {
      const dashboard = await app.container.make('queue.dashboard')
      const manager = await app.container.make('queue.manager')
      const adapter = manager.use('database')
      assert.equal(dashboard.metadata().adapters[0].capabilities.scheduleActions, !readOnly)
      const router = server.getRouter()
      const route = router
        .toJSON()
        .root.find((item: { pattern: string }) => item.pattern.endsWith('/api/schedule/action'))
      assert.isNull(router.match('/admin/queues/api/schedule/action', 'GET', true))
      const call = async (
        action: string,
        options: {
          id?: string
          header?: boolean
          site?: string
          auth?: boolean
          adapter?: string
        } = {},
      ) => {
        const query = new URLSearchParams({
          adapter: options.adapter ?? 'database',
          id: options.id ?? 'daily-digest',
          action,
        })
        const ctx = new HttpContextFactory()
          .merge({ url: `/admin/queues/api/schedule/action?${query}` })
          .create()
        if (options.auth !== false)
          ctx.request.request.headers.authorization = `Basic ${Buffer.from('operator:action-test').toString('base64')}`
        if (options.header !== false) ctx.request.request.headers['x-queue-dashboard'] = '1'
        if (options.site) ctx.request.request.headers['sec-fetch-site'] = options.site
        await route.execute(route, ctx.containerResolver, ctx, (error: Error) => {
          throw error
        })
        return ctx.response.getStatus()
      }
      assert.equal(await call('pause', { auth: false }), 401)
      assert.equal(await call('pause', { header: false }), 403)
      assert.equal(await call('pause', { site: 'cross-site' }), 403)
      if (readOnly) {
        for (const action of ['pause', 'resume', 'trigger', 'delete'])
          assert.equal(await call(action), 403)
        assert.equal(
          await adapter
            .getSchedule('daily-digest')
            .then((value: { status: string }) => value.status),
          'active',
        )
        continue
      }
      assert.equal(await call('invalid'), 400)
      assert.equal(await call('pause', { id: 'bad\n' }), 400)
      assert.equal(await call('pause', { adapter: 'unknown' }), 404)
      assert.equal(await call('pause', { id: 'gone' }), 404)
      assert.equal(await call('pause'), 200)
      assert.equal(
        await adapter.getSchedule('daily-digest').then((value: { status: string }) => value.status),
        'paused',
      )
      const before = await adapter.sizeOf('default')
      assert.equal(await call('trigger'), 200)
      assert.equal(await adapter.sizeOf('default'), before + 1)
      const schedule = await adapter.getSchedule('daily-digest')
      assert.equal(schedule.status, 'paused')
      assert.equal(schedule.runCount, 1)
      assert.instanceOf(schedule.lastRunAt, Date)
      const job = await adapter.popFrom('default')
      assert.deepEqual(job.payload, { token: 'demo-sensitive-value' })
      assert.equal(await call('resume'), 200)
      assert.equal(
        await adapter.getSchedule('daily-digest').then((value: { status: string }) => value.status),
        'active',
      )
      await adapter.updateSchedule('daily-digest', { runCount: 30 })
      assert.equal(await call('trigger'), 409)
      assert.equal(await adapter.sizeOf('default'), before)
      assert.equal(await call('delete'), 200)
      assert.isNull(await adapter.getSchedule('daily-digest'))
      assert.equal(await call('delete'), 404)
    } finally {
      await app.terminate()
    }
  }
})
