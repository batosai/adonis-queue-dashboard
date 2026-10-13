import { assert } from '@japa/assert'
import { browserClient } from '@japa/browser-client'
import { configure, processCLIArgs, run } from '@japa/runner'
processCLIArgs(process.argv.slice(2))
configure({
  suites: [
    { name: 'unit', files: ['tests/unit/**/*.spec.ts'] },
    { name: 'integration', files: ['tests/integration/**/*.spec.ts'] },
    { name: 'browser', files: ['tests/browser/**/*.spec.ts'], timeout: 60_000 },
  ],
  plugins: [assert(), browserClient({ runInSuites: ['browser'] })],
})
run()
