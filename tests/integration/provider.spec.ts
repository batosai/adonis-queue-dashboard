import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/http-server/factories'

test('real Adonis + Lucid + Queue app mounts provider routes without a host frontend pipeline', async ({
  assert,
}) => {
  // JS demo remains runnable directly from the checkout after build.
  const demoUrl = new URL('../../examples/demo/app.mjs', import.meta.url)
  const { createDemo } = await import(demoUrl.href)
  const { app, server } = await createDemo({ password: 'test-only-password' })
  try {
    const router = server.getRouter()
    const route = router
      .toJSON()
      .root.find((item: { pattern: string }) => item.pattern === '/admin/queues/api/counts')
    assert.isDefined(route)
    const ctx = new HttpContextFactory()
      .merge({ url: '/admin/queues/api/counts?adapter=database&queue=emails' })
      .create()
    ctx.request.request.headers.authorization = `Basic ${Buffer.from('operator:test-only-password').toString('base64')}`
    await route.execute(route, ctx.containerResolver, ctx, (error: Error) => {
      throw error
    })
    const result = ctx.response.getBody()
    assert.deepEqual(result.counts.value, {
      pending: 17,
      delayed: 1,
      active: 1,
      completed: 4,
      failed: 2,
    })
    assert.equal(result.pending.value, 17)
  } finally {
    await app.terminate()
  }
})

test('provider exposes router.queueDashboard without mounting routes automatically', async ({
  assert,
}) => {
  const demoUrl = new URL('../../examples/demo/app.mjs', import.meta.url)
  const { createDemo } = await import(demoUrl.href)
  const { app, server } = await createDemo({
    password: 'test-only-password',
    mount: false,
    seed: false,
  })
  try {
    assert.isFunction(server.getRouter().queueDashboard)
    assert.deepEqual(server.getRouter().toJSON().root ?? [], [])
  } finally {
    await app.terminate()
  }
})

test('route macro can also be used in console environments for route discovery', async ({
  assert,
}) => {
  const demoUrl = new URL('../../examples/demo/app.mjs', import.meta.url)
  const { createDemo } = await import(demoUrl.href)
  const { app, server } = await createDemo({
    password: 'test-only-password',
    environment: 'console',
    seed: false,
  })
  try {
    assert.isFunction(server.getRouter().queueDashboard)
    assert.isTrue(
      server
        .getRouter()
        .toJSON()
        .root.some((route: { pattern: string }) => route.pattern === '/admin/queues'),
    )
  } finally {
    await app.terminate()
  }
})
