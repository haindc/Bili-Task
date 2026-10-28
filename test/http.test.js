const { test } = require('node:test')
const http = require('node:http')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createApp, dailyExp, nextRunAt } = require('../index')
const { calcUpgrade, createClient } = require('../lib/bilibili')
const { avatarUrl } = require('../lib/security')
async function server(t, options = {}) {
  let cfg = { cookie: 'private-cookie', tasks: { login: true, watch: true, coin: { enabled: true, count: 3 }, share: false } }
  const api = { conf: () => structuredClone(cfg), saveConf: value => { cfg = structuredClone(value) },
    checkLogin: async () => cfg.cookie ? { uname: 'Test', mid: 1, money: 10, level_info: { current_level: 4, current_exp: 6000 } } : null,
    getTaskStatus: async () => ({ login: true, watch: false, coins: 0, share: false }), calcUpgrade,
    getLoginUrl: async () => ({ url: 'https://example.com/mock-qr', key: 'generated-key' }),
    pollQrLogin: async () => ({ success: true, cookie: 'DO-NOT-EXPOSE' }), ...options.api }
  const app = createApp({ ...options, api })
  const s = app.listen(0, '127.0.0.1'); await once(s, 'listening')
  t.after(() => new Promise(resolve => s.close(resolve)))
  const base = 'http://127.0.0.1:' + s.address().port
  const call = (path, opts = {}) => fetch(base + path, { ...opts, headers: { 'X-BiliTask-Request': '1', 'Content-Type': 'application/json', ...opts.headers } })
  return { app, call, api, base }
}
test('API rejects foreign Host, cross-site Origin, cross-site fetch metadata, and missing mutation header', async t => {
  const { call, base } = await server(t)
  const rawStatus = headers => new Promise((resolve, reject) => { const req = http.get(base + '/api/status', { headers }, res => { res.resume(); resolve(res.statusCode) }); req.on('error', reject) })
  for (const headers of [{ Host: 'evil.test' }, { Host: '127.0.0.1:1' }, { Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal(await rawStatus(headers), 403, JSON.stringify(headers))
  assert.equal((await call('/api/logout', { method: 'POST', headers: { 'X-BiliTask-Request': '' } })).status, 403)
  assert.equal((await call('/api/status')).status, 200)
})
test('config accepts only boolean task flags and integer coin counts 1–5', async t => {
  const { call } = await server(t)
  for (const body of [{ task: 'coin', enabled: true, count: '3' }, { task: 'coin', enabled: true, count: 2.5 }, { task: 'coin', enabled: true, count: 0 }, { task: 'coin', enabled: true, count: 6 }, { task: '__proto__', enabled: true }, { task: 'watch', enabled: 'false' }]) {
    assert.equal((await call('/api/config', { method: 'POST', body: JSON.stringify(body) })).status, 400)
  }
  const r = await call('/api/config', { method: 'POST', body: JSON.stringify({ task: 'share', enabled: false }) }); assert.equal(r.status, 200); assert.equal((await r.json()).tasks.share, false)
})
test('running tasks block account/config changes', async t => {
  const { call } = await server(t, { runner: { isRunning: () => true, runTasks: async () => {} } })
  for (const path of ['/api/config', '/api/logout']) assert.equal((await call(path, { method: 'POST', body: '{}' })).status, 409)
  assert.equal((await call('/api/qrcode')).status, 409)
})
test('avatar host validation rejects SSRF tricks and accepts only HTTPS CDN hosts', () => {
  for (const value of ['http://i0.hdslb.com/a.jpg', 'https://evil.test/hdslb.com', 'https://hdslb.com.evil.test/a', 'https://hdslb.com@127.0.0.1/a', 'https://evilhdslb.com/a', 'https://i0.hdslb.com:8443/a', 'file:///hdslb.com', 'https://127.0.0.1/?hdslb.com', 'https://i0.hdslb.com./a']) assert.throws(() => avatarUrl(value))
  assert.equal(avatarUrl('https://i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg')
})
test('avatar proxy has bounded downloads, blocks redirects and rejects SVG responses', async t => {
  let calls = 0
  const { call } = await server(t, { avatarHttp: { get: async (url, options) => {
    calls++; assert.equal(options.maxRedirects, 0); assert.equal(options.timeout, 10000); assert.equal(options.maxContentLength, 2097152)
    assert.equal(options.headers.Cookie, undefined)
    return { data: Buffer.from('<svg/>'), headers: { 'content-type': 'image/svg+xml' } }
  } } })
  assert.equal((await call('/api/avatar?url=' + encodeURIComponent('https://127.0.0.1/hdslb.com'))).status, 400); assert.equal(calls, 0)
  assert.equal((await call('/api/avatar?url=' + encodeURIComponent('https://i0.hdslb.com/a'))).status, 415)
})
test('status uses nav experience, avoids stale completion fallback, and serializes paused forecasts', async t => {
  const { call } = await server(t, { api: { getTaskStatus: async () => { throw new Error('unavailable') } } })
  let r = await (await call('/api/status')).json(); assert.equal(r.user.currentExp, 6000); assert.equal(r.user.level, 4); assert.equal(r.taskStatus, null); assert.match(r.statusError, /unavailable/)
  for (const task of ['login', 'watch', 'coin', 'share']) await call('/api/config', { method: 'POST', body: JSON.stringify({ task, enabled: false }) })
  r = await (await call('/api/status')).json(); assert.equal(r.dailyExp, 0); assert.equal(r.daysToUpgrade, null)
})
test('QR polling requires a locally issued key and never sends cookies to the browser', async t => {
  let polls = 0
  const { call } = await server(t, { api: { pollQrLogin: async () => { polls++; return { success: true, cookie: 'secret' } } } })
  await call('/api/poll-login?key=unknown'); assert.equal(polls, 0)
  assert.equal((await (await call('/api/qrcode')).json()).key, 'generated-key')
  const r = await (await call('/api/poll-login?key=generated-key')).json(); assert.deepEqual(r, { success: true })
})
test('upstream API business errors are rejected, and heartbeat checks code rather than HTTP success', async () => {
  const client = createClient({ readConfig: () => ({ cookie: '' }), http: { get: async () => ({ data: { code: -403, message: 'denied' } }), post: async () => ({ data: { code: -403 } }) } })
  await assert.rejects(client.getTaskStatus(), /denied/); await assert.rejects(client.checkLogin(), /denied/); assert.equal(await client.playHeartbeat('mock', 1), false)
})
test('malformed reward data is rejected instead of interpreted as no coins spent', async () => {
  const client = createClient({ readConfig: () => ({ cookie: '' }), http: { get: async () => ({ data: { code: 0, data: {} } }) } })
  await assert.rejects(client.getTaskStatus(), /无法确认/)
})
test('forecast respects share opt-out, level zero and maximum level', () => {
  assert.equal(dailyExp({ login: false, watch: false, share: false, coin: { enabled: false } }), 0)
  assert.equal(dailyExp({ login: true, watch: true, share: false, coin: { enabled: true, count: 3 } }), 40)
  assert.equal(calcUpgrade({ level_info: { current_level: 0, current_exp: 0 } }).level, 0)
  assert.equal(calcUpgrade({ level_info: { current_level: 6, current_exp: 50000 } }).remain, 0)
  assert.equal(nextRunAt(new Date('2026-10-27T22:59:00Z')), '2026-10-27T23:00:00.000Z')
  assert.equal(nextRunAt(new Date('2026-10-27T23:00:00Z')), '2026-10-28T23:00:00.000Z')
})
test('login polling and task execution cannot switch credentials concurrently', async t => {
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const { call } = await server(t, { api: { pollQrLogin: async () => { entered(); await gate; return { success: true } } } })
  await call('/api/qrcode')
  const poll = call('/api/poll-login?key=generated-key')
  await started
  const run = await call('/api/run', { method: 'POST' }); assert.equal(run.status, 409)
  release(); assert.equal((await poll).status, 200)
})
