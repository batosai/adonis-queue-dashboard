import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Storage layouts audited against 0.6.0, 0.9.0 and 0.9.1.
// Accept stable patches of the audited 0.9 storage family, but require a new
// audit for other minor versions and prereleases.
export const supportedQueueStorageVersions = ['0.6.0', '0.9.x'] as const

export function supportsQueueScheduleActions(version: string): boolean {
  return /^0\.9\.(?:0|[1-9]\d*)(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(version)
}

export function supportsQueueStorage(version: string): boolean {
  return version === '0.6.0' || supportsQueueScheduleActions(version)
}

/** Resolve metadata from the host's Queue dependency tree, not our dev dependency. */
export async function queueStorageVersion(hostPackagePath: string): Promise<string> {
  const hostRequire = createRequire(hostPackagePath)
  const queueRequire = createRequire(hostRequire.resolve('@adonisjs/queue'))
  let directory = dirname(queueRequire.resolve('@boringnode/queue'))
  for (let depth = 0; depth < 6; depth++) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (manifest.name === '@boringnode/queue') return manifest.version
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    directory = dirname(directory)
  }
  throw new Error('Cannot identify the host queue storage version')
}
