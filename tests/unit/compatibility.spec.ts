import { test } from '@japa/runner'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  queueStorageVersion,
  supportsQueueStorage,
  supportsQueueScheduleActions,
} from '../../src/compatibility.js'

test('storage readers accept audited storage families and keep unknown versions on the public fallback', ({
  assert,
}) => {
  for (const version of ['0.6.0', '0.9.0', '0.9.1', '0.9.12', '0.9.1+build.1'])
    assert.isTrue(supportsQueueStorage(version))
  for (const version of [
    '0.6.1',
    '0.7.0',
    '0.8.0',
    '0.10.0',
    '1.0.0',
    '0.9.1-beta.1',
    '0.9',
    '0.9.01',
    '0.9.1.2',
    '0.9.x',
    '',
  ])
    assert.isFalse(supportsQueueStorage(version))
})

test('schedule actions follow the supported 0.9 patch family', ({ assert }) => {
  for (const version of ['0.9.0', '0.9.1', '0.9.12', '0.9.1+build.1'])
    assert.isTrue(supportsQueueScheduleActions(version))
  for (const version of ['0.6.0', '0.6.1', '0.10.0', '1.0.0', '0.9.1-beta.1', '0.9.01', ''])
    assert.isFalse(supportsQueueScheduleActions(version))
})

test('storage version resolves from the host Queue dependency tree, including nested Boring installs', async ({
  assert,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-compatibility-'))
  const queuePath = join(root, 'node_modules/@adonisjs/queue')
  const nestedPath = join(queuePath, 'node_modules/@boringnode/queue')
  try {
    await mkdir(nestedPath, { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(
      join(queuePath, 'package.json'),
      JSON.stringify({ name: '@adonisjs/queue', main: 'index.js' }),
    )
    await writeFile(join(queuePath, 'index.js'), '')
    await writeFile(join(nestedPath, 'index.js'), '')
    for (const version of ['0.6.0', '0.9.0', '0.9.1', '1.0.0']) {
      await writeFile(
        join(nestedPath, 'package.json'),
        JSON.stringify({ name: '@boringnode/queue', version, main: 'index.js' }),
      )
      assert.equal(await queueStorageVersion(join(root, 'package.json')), version)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
