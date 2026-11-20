'use strict'
// The game's dedicated server. The game page itself, unchanged, is served on loopback and run in headless Chromium in its
// server mode. Hook modules from HOOKS_DIR run inside the page against its hooks (globalThis.gameHooks). Every event goes
// out as a JSON line on stdout and, signed, to each webhook that wants it. A small HTTP API acts on the room.
// Configuration is the environment; see README.md.
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto')

const env = process.env
const say = msg => process.stderr.write(msg + '\n')
const die = (msg, code = 2) => { say('server: ' + msg); process.exit(code) }
const sleep = ms => new Promise(ok => setTimeout(ok, ms))
const blank = v => v === undefined || v === ''
// a broadcast the game takes, as the page judges it too
const streamOk = u => { try { const p = new URL(u); return u.length <= 1024 && p.protocol === 'https:' && !p.username && !p.password } catch (e) { return false } }
// a host on this machine or its network, as the game judges it: players' browsers refuse a stream there unless the page
// they join from (JOIN_URL) is there too, or a file
function localHost(h) {
  if (/(^|\.)localhost\.?$|\.local\.?$/.test(h)) return true
  const v6 = /^\[(.+)\]$/.exec(h)?.[1], m = v6 && /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(v6)
  if (v6 && !m) return v6 === '::' || v6 === '::1' || /^(f[cd][\da-f]{2}|fe[89ab][\da-f]):/.test(v6)
  const ip = m ? [m[1], m[2]].flatMap(g => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]) : /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)?.slice(1).map(Number)
  if (!ip) return false
  const [a, b] = ip
  return a === 0 || a === 10 || a === 127 || a === 100 && b >= 64 && b < 128 || a === 169 && b === 254 || a === 172 && b >= 16 && b < 32 ||
    a === 192 && b === 168 || a === 198 && (b === 18 || b === 19)
}
const localUrl = u => { try { const p = new URL(u); return !/^https?:$/.test(p.protocol) || localHost(p.hostname) } catch (e) { return false } }
const streamLocal = u => localUrl(u) && !localUrl(env.JOIN_URL)
const LOCAL_STREAM = "a stream on this machine or a private network is refused, as players' browsers refuse it from the public page; a JOIN_URL on one allows it"
// A setting's file. Its errors name the setting, never the path, which may be the secret itself given by mistake
const readFile = (f, what) => { try { return fs.readFileSync(f, 'utf8') } catch (e) { die(what + ': cannot read the file (' + (e.code || e.name) + ')') } }
const read = (f, what) => readFile(f, what).trim()
// A file of JSON. A fault is told by its line and column, never by the text around it, which may hold a secret
function readJson(f, what) {
  const text = readFile(f, what)
  try { return JSON.parse(text) } catch (e) { die(what + ': not valid JSON at ' + jsonFault(text, e)) }
}
// V8 gives most faults' line and column; an unexpected token is the last character of the shortest prefix that fails
// on something other than its end
function jsonFault(text, e) {
  const at = /\(line (\d+) column (\d+)\)/.exec(e.message)
  if (at) return 'line ' + at[1] + ', column ' + at[2]
  const ends = s => { try { JSON.parse(s); return true } catch (e) { const p = /at position (\d+)/.exec(e.message); return /end of JSON input/.test(e.message) || !!p && +p[1] >= s.length } }
  let lo = 0, hi = text.length, fault = text.length
  if (!ends(text)) { while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ends(text.slice(0, mid))) lo = mid; else hi = mid } fault = hi - 1 }
  const lines = text.slice(0, fault).split('\n')
  return 'line ' + lines.length + ', column ' + (lines[lines.length - 1].length + 1)
}

// ---- configuration
const number = (k, lo, hi, whole) => {
  if (blank(env[k])) return undefined
  const n = Number(env[k])
  if (!(Number.isFinite(n) && n >= lo && n <= hi && (!whole || Number.isInteger(n)))) die(`${k} must be ${whole ? 'a whole number' : 'a number'} from ${lo} to ${hi}`)
  return n
}
// '*': every type; 'a,b': those; '-a,-b': every type but those
const types = (v, what) => {
  const list = (Array.isArray(v) ? v : String(v).split(',')).map(s => String(s).trim()).filter(Boolean)
  if (!list.length) die(what + ': no event types')
  if (list.length === 1 && list[0] === '*') return () => true
  const no = list.filter(s => s.startsWith('-')).map(s => s.slice(1)), yes = list.filter(s => !s.startsWith('-'))
  if (no.length && yes.length) die(what + ': list the types to send, or the types to leave out, not both')
  return no.length ? t => !no.includes(t) : t => yes.includes(t)
}
const WEBHOOK_DEFAULT = '-damage,-chat'
function webhook(h, where, secretFile) {
  if (!h || typeof h !== 'object') die(where + ': a webhook is { url, secret | secretFile, events }')
  let u
  try { u = new URL(h.url) } catch (e) { die(where + ': its url is not a URL') }
  if (u.protocol !== 'https:') die(where + ': a webhook url must be https')
  const file = h.secretFile ?? ''
  if (typeof file !== 'string') die(secretFile + ' must be a path')
  const secret = file ? read(file, secretFile) : h.secret
  if (typeof secret !== 'string' || !secret.trim()) die(where + ': needs a secret, a string (secret, or secretFile)')
  return new Webhook(u.href, u.origin, secret, types(h.events ?? WEBHOOK_DEFAULT, where))
}
function webhooks() {
  const out = [], file = env.WEBHOOKS_FILE || '/config/webhooks.json'
  if (fs.existsSync(file)) {
    const list = readJson(file, file)
    if (!Array.isArray(list)) die(file + ' must hold a list of webhooks')
    list.forEach((h, i) => out.push(webhook(h, file + ' #' + (i + 1), file + ' #' + (i + 1) + ': its secretFile')))
  } else if (!blank(env.WEBHOOKS_FILE)) die('WEBHOOKS_FILE: no such file')
  if (!blank(env.WEBHOOK_URL))
    out.push(webhook({ url: env.WEBHOOK_URL, secret: env.WEBHOOK_SECRET, secretFile: env.WEBHOOK_SECRET_FILE, events: env.WEBHOOK_EVENTS }, 'WEBHOOK_URL', 'WEBHOOK_SECRET_FILE'))
  return out
}

// ---- webhooks: one request in flight each, so events arrive in order; a failed one is sent again, the same bytes, until
// five minutes after it happened. Each attempt carries its own timestamp and signature.
const BACKOFF_S = [1, 5, 30, 60], GIVE_UP_MS = 5 * 60000, QUEUE_MAX = 10000, ATTEMPT_MS = 10000
class Webhook {
  constructor(url, origin, secret, wants) {
    Object.assign(this, { url, origin, wants, queue: [], busy: false, delivered: 0, dropped: 0, failing: '', toldDrops: 0 })
    Object.defineProperty(this, 'secret', { value: secret, enumerable: false })
  }
  push(e) {
    this.queue.push(e)
    if (this.queue.length > QUEUE_MAX) { this.queue.splice(this.busy ? 1 : 0, 1); this.drop('the queue is full') }
    this.run()
  }
  drop(why) {
    this.dropped++
    if (Date.now() - this.toldDrops > 10000) { this.toldDrops = Date.now(); say(`webhook ${this.origin}: dropped an event (${why}); ${this.dropped} so far`) }
  }
  async run() {
    if (this.busy) return
    this.busy = true
    while (this.queue.length) {
      const e = this.queue[0]
      if (Date.now() - e.at > GIVE_UP_MS) { this.queue.shift(); this.drop('not delivered within five minutes'); continue }
      if (await this.post(e)) {
        this.queue.shift(); this.delivered++
        if (this.failing) { this.failing = ''; say(`webhook ${this.origin}: delivering again`) }
        continue
      }
      if (!this.failing) say(`webhook ${this.origin}: ${this.why}; trying again`)
      this.failing = this.why
      await sleep(Math.min(BACKOFF_S[Math.min(e.tries, BACKOFF_S.length) - 1] * 1000, Math.max(0, e.at + GIVE_UP_MS - Date.now())))
    }
    this.busy = false
  }
  async post(e) {
    e.tries++
    const ts = String(Math.floor(Date.now() / 1000))
    const signature = 'sha256=' + crypto.createHmac('sha256', this.secret).update(ts + '.' + e.body).digest('hex')
    try {
      const r = await fetch(this.url, { method: 'POST', body: e.body, redirect: 'manual', signal: AbortSignal.timeout(ATTEMPT_MS),
        headers: { 'Content-Type': 'application/json', 'X-Game-Event-Id': e.id, 'X-Game-Timestamp': ts, 'X-Game-Signature': signature } })
      await r.arrayBuffer().catch(() => {})
      if (r.status >= 200 && r.status < 300) return true
      this.why = 'answered ' + r.status
    } catch (err) {
      this.why = err.name === 'TimeoutError' ? 'no answer in ' + ATTEMPT_MS / 1000 + ' s' : 'unreachable (' + (err.cause?.code || err.name) + ')'
    }
    return false
  }
  get status() { return { origin: this.origin, queued: this.queue.length, delivered: this.delivered, dropped: this.dropped, failing: this.failing || null } }
}

const CFG = {
  game: env.GAME_FILE || path.join(__dirname, 'game.html'),
  joinUrl: env.JOIN_URL || '',
  hooksDir: path.resolve(env.HOOKS_DIR || '/hooks'),
  broadcast: blank(env.BROADCAST_URL) ? '' : !streamOk(env.BROADCAST_URL) ? die('BROADCAST_URL: an https URL with no credentials in it, at most 1024 characters')
    : streamLocal(env.BROADCAST_URL) ? die('BROADCAST_URL: ' + LOCAL_STREAM) : env.BROADCAST_URL,
  stdout: types(env.STDOUT_EVENTS || '*', 'STDOUT_EVENTS'),
  serve: Object.fromEntries(Object.entries({
    code: env.ROOM_CODE, level: env.LEVEL, mode: env.MODE, name: env.SERVER_NAME,
    frags: number('FRAGS', 0, 200, true), minutes: number('MINUTES', 0, 60), enemies: number('ENEMIES', 0, 100, true),
  }).filter(([, v]) => !blank(v))),
  api: { host: env.ACTION_HOST || '127.0.0.1', port: number('ACTION_PORT', 0, 65535, true) ?? 8080,
         token: env.ACTION_TOKEN_FILE ? read(env.ACTION_TOKEN_FILE, 'ACTION_TOKEN_FILE') || die('ACTION_TOKEN_FILE: the file is empty') : env.ACTION_TOKEN || '' },
}
const HOOKS = webhooks()
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/
if (CFG.api.port && !LOOPBACK.test(CFG.api.host) && !CFG.api.token)
  die(`the action API on ${CFG.api.host} is beyond loopback: set ACTION_TOKEN or ACTION_TOKEN_FILE, or keep ACTION_HOST=127.0.0.1`)
let html
try { html = fs.readFileSync(CFG.game) } catch (e) { die((env.GAME_FILE ? 'GAME_FILE' : 'the game') + ': cannot read the file (' + e.code + ')') }

// ---- the page, served on loopback: the game, and the hook modules under /hooks/
const unescaped = s => { try { return decodeURIComponent(s) } catch (e) { return '' } }
function serveFiles() {
  const files = http.createServer((req, res) => {
    const u = URL.parse(req.url, 'http://loopback'), type = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' }
    if (req.method !== 'GET') { res.writeHead(405); return res.end() }
    if (u?.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(html) }
    const m = u && /^\/hooks\/(.+)$/.exec(u.pathname), f = m && path.resolve(CFG.hooksDir, unescaped(m[1]))
    if (f && f.startsWith(CFG.hooksDir + path.sep) && type[path.extname(f)] && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'Content-Type': type[path.extname(f)] + '; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(f))
    }
    res.writeHead(404); res.end()
  })
  return new Promise(ok => files.listen(0, '127.0.0.1', () => ok(files.address().port)))
}

// ---- events: the page numbers them; each gets its id here, the same on stdout and on every webhook
process.stdout.on('error', () => {})
function onEvent(json) {
  let e
  try { e = JSON.parse(json) } catch (err) { return }
  const id = crypto.randomUUID(), body = JSON.stringify({ id, type: e.type, ts: e.ts, seq: e.seq, game: 'superkillers', match: e.match, data: e.data })
  if (CFG.stdout(e.type)) process.stdout.write(body + '\n')
  for (const h of HOOKS) if (h.wants(e.type)) h.push({ id, body, at: e.ts * 1000, tries: 0 })
}
// in the page: every event, numbered in the order the page makes them, and the bridge's own ping
const BRIDGE = () => {
  let seq = 0
  const out = (type, match, data) => globalThis.serverOut(JSON.stringify({ type, ts: Date.now() / 1000, seq: ++seq, match, data }))
  gameHooks.on('*', (data, meta) => out(meta.type, meta.match, data))
  globalThis.serverPing = reason => { const r = gameHooks.room(); out('ping', r.match, { reason, players: r.players, enemies: r.enemies, level: r.level, uptime: r.uptime }) }
}

// ---- the action API: loopback unless a token guards it; programs only, so a request a browser sends (Origin) is refused
function actionApi(page) {
  if (!CFG.api.port) return say('action API: off')
  const want = CFG.api.token && crypto.createHash('sha256').update(CFG.api.token).digest()
  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]'].map(h => h + ':' + CFG.api.port))
  const act = (name, ...args) => page.evaluate(([n, a]) => gameHooks[n](...a), [name, args])
  const ROUTES = {
    'GET /health': async () => [(await act('room')).open ? 200 : 503, {}],
    'GET /status': async () => { const r = await act('room')
      return [200, { code: r.code, link: CFG.joinUrl ? CFG.joinUrl + '#' + r.code : '', level: r.level, mode: r.mode, fragLimit: r.fragLimit, minutes: r.minutes,
        match: r.match, players: r.players, enemies: r.enemies, uptime: r.uptime, signaling: r.signaling, hookFailures: r.hookFailures,
        lastHookFailure: r.lastHookFailure, broadcast: r.broadcast, webhooks: HOOKS.map(h => h.status) }] },
    'GET /players': async () => [200, { players: await act('players') }],
    'POST /ping': async () => { await page.evaluate(() => serverPing('request')); return [200, {}] },
    'POST /announce': async b => [200, { done: await act('announce', b.text) }],
    'POST /tell': async b => [200, { done: await act('tell', b.id, b.text) }],
    'POST /kick': async b => [200, { done: await act('kick', b.id ?? b.name) }],
    'POST /command': async b => { const lines = await act('command', b.line); return [200, { done: lines !== false, lines: lines || [] }] },
    'POST /level': async b => [200, { done: await act('setLevel', b.level) }],
    'POST /frags': async b => [200, { done: await act('setFragLimit', b.frags) }],
    'POST /minutes': async b => [200, { done: await act('setMatchMinutes', b.minutes) }],
    'POST /enemies': async b => [200, { done: await act('setEnemies', b.enemies) }],
    'POST /restart': async () => [200, { done: await act('restart') }],
    'POST /broadcast': async b => typeof b.url === 'string' && streamOk(b.url) && streamLocal(b.url) ? [400, { error: LOCAL_STREAM }]
      : [200, { done: await act('broadcast', b.url ?? null) }],
  }
  const api = http.createServer((req, res) => {
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: code === 200, ...o }) + '\n') }
    if (req.headers.origin !== undefined) return send(403, { error: 'requests from a browser page are refused' })
    if (want) {
      const t = /^Bearer (.+)$/.exec(req.headers.authorization || '')
      if (!t || !crypto.timingSafeEqual(crypto.createHash('sha256').update(t[1]).digest(), want)) return send(401, { error: 'needs Authorization: Bearer <ACTION_TOKEN>' })
    } else if (!hosts.has(req.headers.host)) return send(403, { error: 'unexpected Host' })
    const u = URL.parse(req.url, 'http://loopback'), route = u && ROUTES[req.method + ' ' + u.pathname]
    if (!route) return send(u && Object.keys(ROUTES).some(k => k.endsWith(' ' + u.pathname)) ? 405 : 404, { error: 'no such action' })
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', d => { raw += d; if (raw.length > 16384) { send(413, { error: 'body too large' }); req.destroy() } })
    req.on('end', async () => {
      if (res.headersSent) return
      let body = {}
      if (raw.trim()) try { body = JSON.parse(raw) } catch (e) { return send(400, { error: 'the body is not JSON' }) }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'the body must be a JSON object' })
      try { const [code, o] = await route(body); send(code, o) } catch (e) { send(500, { error: String(e.message || e).slice(0, 200) }) }
    })
  })
  api.on('error', e => die('the action API cannot listen on ' + CFG.api.host + ':' + CFG.api.port + ': ' + e.code, 1))
  api.listen(CFG.api.port, CFG.api.host, () => say(`action API: http://${CFG.api.host.includes(':') ? '[' + CFG.api.host + ']' : CFG.api.host}:${CFG.api.port}/` + (want ? ' (bearer token)' : '')))
}

// ---- run
let browser = null, stopping = false
async function stop(code) {
  if (stopping) return
  stopping = true
  say('server: stopping')
  try { await page?.evaluate(() => gameHooks.stop()) } catch (e) {}
  await sleep(500)                     // the guests' goodbye, and the match's end
  for (const until = Date.now() + 7000; HOOKS.some(h => h.queue.length) && Date.now() < until;) await sleep(100)
  for (const h of HOOKS) if (h.queue.length) say(`webhook ${h.origin}: ${h.queue.length} events not delivered`)
  await browser?.close().catch(() => {})
  process.exit(code)
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stop(0))
let page = null
;(async () => {
  const { chromium } = require('playwright')
  const port = await serveFiles()
  browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    // guests on the same network reach the server by its own address
    '--disable-features=WebRtcHideLocalIpsWithMdns'] })
  browser.on('disconnected', () => { if (!stopping) die('the browser closed', 1) })
  page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  page.on('crash', () => die('the game page crashed', 1))
  page.on('pageerror', e => say('page: ' + e.message))
  page.on('console', m => { if (m.type() === 'error') say('page: ' + m.text()) })
  await page.exposeFunction('serverOut', onEvent)
  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 180000 })
  await page.waitForFunction(() => globalThis.gameHooks?.room().ready || /fail|broke/i.test(document.getElementById('status')?.textContent || ''),
    null, { timeout: 180000, polling: 500 }).catch(() => {})
  const r0 = await page.evaluate(() => globalThis.gameHooks ? gameHooks.room() : null)
  if (!r0?.ready) die('the game did not start: ' + (r0?.status || await page.textContent('#status').catch(() => '') || 'no hooks in this copy of the game'), 1)
  await page.evaluate(BRIDGE)
  let mods = []
  try { if (fs.existsSync(CFG.hooksDir)) mods = fs.readdirSync(CFG.hooksDir).filter(f => /^[^.].*\.m?js$/.test(f) && fs.statSync(path.join(CFG.hooksDir, f)).isFile()).sort() }
  catch (e) { die('HOOKS_DIR: cannot read it (' + e.code + ')') }
  for (const f of mods) {
    const err = await page.evaluate(async url => {
      const slow = {}
      try {
        const m = await import(url)
        if (typeof m.default !== 'function') return 'it has no default export function'
        await Promise.race([m.default(gameHooks), new Promise((ok, no) => setTimeout(() => no(slow), 30000))])
        return ''
      } catch (e) {
        if (e === slow) return 'its setup took over 30 s'
        // the kind of error and where, never its message, which can quote the module
        const at = /^(\d+):(\d+)/.exec(String(e?.stack).split(url + ':')[1] || '')
        return 'a ' + (/^[A-Z][A-Za-z]{0,30}Error$/.test(e?.name) ? e.name : 'thrown value')
          + (at ? ' at line ' + at[1] + ', column ' + at[2] : e?.name === 'SyntaxError' ? ' (node --check on it shows where)' : '')
      }
    }, '/hooks/' + encodeURIComponent(f))
    if (err) die('hook module ' + f + ': ' + err, 1)
    say('hooks: ' + f)
  }
  const why = await page.evaluate(o => { try { return gameHooks.serve(o) ? '' : 'the game is not on its landing page' } catch (e) { return e.message } }, CFG.serve)
  if (why) die('cannot serve: ' + why)
  let r = null, told = ''
  for (const t0 = Date.now(); ; await sleep(500)) {
    r = await page.evaluate(() => gameHooks.room())
    if (r.status !== told) { told = r.status; if (told) say('game: ' + told) }
    if (r.open) break
    if (/error|could not/i.test(r.status)) die('the room did not open', 1)
    if (Date.now() - t0 > 180000) die('the room did not open in 3 minutes', 1)
  }
  say(`Room ${r.code}  ${r.level}` + (CFG.joinUrl ? `  join: ${CFG.joinUrl}#${r.code}` : '  (set JOIN_URL to print a join link)'))
  await page.evaluate(() => serverPing('start'))
  if (CFG.broadcast) await page.evaluate(u => gameHooks.broadcast(u), CFG.broadcast)
  actionApi(page)
  for (let was = r.signaling; !stopping; await sleep(2000)) {
    r = await page.evaluate(() => gameHooks.room()).catch(e => { if (!stopping) throw e })
    if (stopping) return
    if (!r.serving) return stop(0)
    if (r.signaling !== was) { was = r.signaling; say('signaling: ' + was) }
  }
})().catch(e => { if (!stopping) die(String(e?.stack || e), 1) })
