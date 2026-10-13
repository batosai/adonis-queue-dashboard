import type { BaseCommand } from '@adonisjs/core/ace'
import { fileURLToPath } from 'node:url'

export async function configure(command: BaseCommand) {
  const codemods = await command.createCodemods()
  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@jrmc/adonis-queue-dashboard/dashboard_provider')
  })
  await codemods.makeUsingStub(
    fileURLToPath(new URL('./stubs/', import.meta.url)),
    'config/queue_dashboard.stub',
    {},
  )
}
