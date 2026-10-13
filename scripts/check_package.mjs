import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}

// Install the archive as a consumer would, outside the checkout's node_modules.
const directory = await mkdtemp(join(tmpdir(), 'queue-dashboard-package-'))
try {
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', directory])
  const archives = (await readdir(directory)).filter((file) => file.endsWith('.tgz'))
  assert.equal(archives.length, 1, 'npm pack must produce one archive')

  const host = join(directory, 'host')
  await mkdir(host)
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  await writeFile(
    join(host, 'package.json'),
    JSON.stringify({
      name: 'dashboard-test-host',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: {
        [manifest.name]: `file:${join(directory, archives[0])}`,
        '@adonisjs/core': manifest.devDependencies['@adonisjs/core'],
        '@adonisjs/queue': manifest.devDependencies['@adonisjs/queue'],
        '@adonisjs/lucid': manifest.devDependencies['@adonisjs/lucid'],
        'better-sqlite3': manifest.devDependencies['better-sqlite3'],
      },
    }),
  )
  run('npm', ['install', '--no-audit', '--no-fund'], host)
  const packageRoot = join(host, 'node_modules', manifest.name)
  const files = await readdir(join(packageRoot, 'build'), { recursive: true })
  assert.ok(files.some((file) => file.endsWith('.vite/manifest.json')))
  assert.ok(files.some((file) => file.endsWith('queue_dashboard.stub')))
  assert.ok(files.some((file) => file.endsWith('.css')))
  assert.ok(!files.includes('tests') && !files.includes('bin'))
  await cp('examples/demo/app.mjs', join(host, 'app.mjs'))
  await writeFile(
    join(host, 'check.mjs'),
    `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createDemo } from './app.mjs'
import { configure, defineConfig } from '@jrmc/adonis-queue-dashboard'
import { states } from '@jrmc/adonis-queue-dashboard/types'
const require = createRequire(import.meta.url)
for (const name of ['vue', 'vite', 'tailwindcss', 'reka-ui']) {
  assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' })
}
assert.equal(states.length, 5)
assert.deepEqual(defineConfig({ adapters: {} }).adapters, {})
const calls = []
await configure({ createCodemods: async () => ({
  updateRcFile: async (callback) => callback({ addProvider: (name, environments) => calls.push([name, environments]) }),
  makeUsingStub: async (root, name) => {
    const { readFile } = await import('node:fs/promises')
    assert.ok((await readFile(root + '/' + name, 'utf8')).includes('router.queueDashboard'))
  },
}) })
assert.deepEqual(calls, [['@jrmc/adonis-queue-dashboard/dashboard_provider', undefined]])
const { app, server } = await createDemo({ root: new URL('./', import.meta.url), password: 'test-only-password' })
assert.ok(server.getRouter().toJSON().root.some((route) => route.pattern === '/admin/queues'))
await app.terminate()
console.log('Tarball imports, configure stub, provider boot and host without frontend dependencies: passed')
`,
  )
  run(process.execPath, ['check.mjs'], host)
} finally {
  await rm(directory, { recursive: true, force: true })
}
