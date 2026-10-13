import { createInternalClient } from './internal'

/** Makes one call and never calls `close()`: the process must still exit on its own. */
const client = createInternalClient({
  baseUrl: process.env.TARGET ?? '',
  secret: 'child-secret',
  environment: 'local',
  keepAlive: true,
})
const answer = await client.request({ method: 'GET', path: '/' })
if (answer.status !== 200) {
  process.exit(2)
}
