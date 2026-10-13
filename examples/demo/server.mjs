import { createServer } from 'node:http'
import { createDemo } from './app.mjs'

const { app, server } = await createDemo({ password: process.env.DASHBOARD_PASSWORD })
const nodeServer = createServer(server.handle.bind(server))
server.setNodeServer(nodeServer)
nodeServer.listen(Number(process.env.PORT ?? 3333), '127.0.0.1', () => {
  console.log(
    'Demo available at http://127.0.0.1:' +
      nodeServer.address().port +
      '/admin/queues (user: operator)',
  )
})
nodeServer.on('error', async (error) => {
  console.error(error.message)
  await app.terminate()
  process.exitCode = 1
})
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    nodeServer.closeAllConnections()
    nodeServer.close()
    await app.terminate()
  })
