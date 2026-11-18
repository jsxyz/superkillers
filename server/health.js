'use strict'
// The image's health check: healthy while the room is open, as the action API's /health on this machine says.
const fs = require('fs'), env = process.env
const port = Number(env.ACTION_PORT || 8080)
if (!port) process.exit(0)                     // the API is off: nothing to ask
const host = /^(0\.0\.0\.0|::)?$/.test(env.ACTION_HOST || '') ? '127.0.0.1' : env.ACTION_HOST
let token = env.ACTION_TOKEN
try { if (env.ACTION_TOKEN_FILE) token = fs.readFileSync(env.ACTION_TOKEN_FILE, 'utf8').trim() } catch (e) { process.exit(1) }   // silent: its output is kept
fetch(`http://${host.includes(':') ? '[' + host + ']' : host}:${port}/health`, { headers: token ? { Authorization: 'Bearer ' + token } : {}, signal: AbortSignal.timeout(4000) })
  .then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))
