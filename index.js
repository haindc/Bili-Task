const express = require('express')
const cron = require('node-cron')
const QRCode = require('qrcode')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const defaultApi = require('./lib/bilibili')
const { createTaskRunner } = require('./lib/tasks')
const { localOnly, avatarUrl } = require('./lib/security')

function dailyExp(tasks = {}) {
  return (tasks.login ? 5 : 0) + (tasks.watch ? 5 : 0) + (tasks.coin?.enabled ? Math.max(1, Math.min(5, Number(tasks.coin.count) || 3)) * 10 : 0) + (tasks.share ? 5 : 0)
}
function nextRunAt(now = new Date()) {
  const china = new Date(now.getTime() + 8 * 3600000)
  china.setUTCHours(7, 0, 0, 0)
  if (china.getTime() - 8 * 3600000 <= now.getTime()) china.setUTCDate(china.getUTCDate() + 1)
  return new Date(china.getTime() - 8 * 3600000).toISOString()
}
function createApp({ api = defaultApi, runner = createTaskRunner(api), avatarHttp = axios, preview = false } = {}) {
  const app = express()
  const qrKeys = new Map()
  let lastRun = null
  let loginPolling = false
  app.disable('x-powered-by')
  app.use(localOnly)
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Referrer-Policy', 'no-referrer')
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store')
    next()
  })
  app.use(express.json({ limit: '8kb' }))
  app.use(express.static(path.join(__dirname, 'public')))
  const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next)
  const idle = (req, res, next) => runner.isRunning() || loginPolling
    ? res.status(409).json({ success: false, error: '任务正在运行，请完成后再修改设置或登录状态' }) : next()

  app.get('/api/qrcode', idle, route(async (req, res) => {
    for (const [key, expires] of qrKeys) if (expires < Date.now()) qrKeys.delete(key)
    if (qrKeys.size >= 50) return res.status(429).json({ success: false, error: '二维码请求过于频繁，请稍后重试' })
    const { url, key } = await api.getLoginUrl()
    const qrcode = await QRCode.toDataURL(url, { width: 260, margin: 1, color: { dark: '#202124', light: '#ffffff' } })
    qrKeys.set(key, Date.now() + 180000)
    res.json({ success: true, qrcode, key })
  }))
  app.get('/api/poll-login', idle, route(async (req, res) => {
    const key = req.query.key
    if (typeof key !== 'string' || !qrKeys.has(key) || qrKeys.get(key) < Date.now()) {
      return res.json({ success: false, status: 'expired' })
    }
    let result
    loginPolling = true
    try { result = await api.pollQrLogin(key) } finally { loginPolling = false }
    if (result.success || result.status === 'expired') { qrKeys.delete(key); lastRun = null }
    res.json(result.success ? { success: true } : { success: false, status: result.status })
  }))
  app.get('/api/status', route(async (req, res) => {
    const cfg = api.conf(), user = await api.checkLogin()
    const shared = { tasks: cfg.tasks || {}, running: runner.isRunning(), nextRunAt: nextRunAt(), preview }
    if (!user) return res.json({ ...shared, loggedIn: false })
    const level = api.calcUpgrade(user), daily = dailyExp(cfg.tasks)
    let taskStatus = null, statusError = null
    try { taskStatus = await api.getTaskStatus() } catch (e) { statusError = e.message }
    res.json({ ...shared, loggedIn: true,
      user: { name: user.uname, face: user.face, mid: user.mid, coins: user.money || 0, ...level },
      taskStatus, statusError, dailyExp: level.level >= 6 ? 0 : daily,
      daysToUpgrade: level.level >= 6 ? 0 : daily ? Math.ceil(level.remain / daily) : null, lastRun
    })
  }))
  app.post('/api/config', idle, route(async (req, res) => {
    const { task, enabled, count } = req.body || {}
    if (!['login', 'watch', 'coin', 'share'].includes(task) || typeof enabled !== 'boolean' ||
        (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 5))) {
      return res.status(400).json({ success: false, error: '任务配置无效：投币数量须为 1–5 的整数' })
    }
    const cfg = api.conf()
    cfg.tasks ||= {}
    if (task === 'coin') cfg.tasks.coin = { enabled, count: count ?? cfg.tasks.coin?.count ?? 3 }
    else cfg.tasks[task] = enabled
    api.saveConf(cfg)
    res.json({ success: true, tasks: cfg.tasks })
  }))
  async function execute() {
    if (loginPolling) throw Object.assign(new Error('正在确认登录，请稍后运行'), { statusCode: 409 })
    lastRun = await runner.runTasks()
    return lastRun
  }
  app.post('/api/run', route(async (req, res) => {
    const result = await execute()
    res.json({ success: true, result, taskStatus: result.taskStatus ?? null })
  }))
  app.get('/api/avatar', route(async (req, res) => {
    let url
    try { url = avatarUrl(req.query.url) } catch { return res.status(400).send('invalid avatar URL') }
    const r = await avatarHttp.get(url, {
      responseType: 'arraybuffer', maxRedirects: 0, timeout: 10000, maxContentLength: 2 * 1024 * 1024,
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' }
    })
    const type = (r.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(type)) return res.status(415).send('unsupported image')
    res.type(type).set('Cache-Control', 'private, max-age=86400').send(Buffer.from(r.data))
  }))
  app.post('/api/logout', idle, route(async (req, res) => {
    api.saveConf({ ...api.conf(), cookie: '', token: '' })
    qrKeys.clear()
    lastRun = null
    res.json({ success: true })
  }))
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err)
    const status = err.statusCode || err.status || 502
    res.status(status >= 400 && status <= 599 ? status : 500).json({ success: false, error: err.message || '请求失败，请稍后重试', code: err.code })
  })
  app.locals.executeTasks = execute
  return app
}
function start() {
  const configPath = path.join(__dirname, 'config.json')
  if (!fs.existsSync(configPath)) fs.copyFileSync(path.join(__dirname, 'config.example.json'), configPath)
  const app = createApp()
  const port = Number(process.env.PORT || 8000)
  const server = app.listen(port, '127.0.0.1', () => {
    console.log('BiliTask 已启动: http://localhost:' + port)
    fs.writeFileSync(path.join(__dirname, '.pid'), String(process.pid))
    if (process.env.BILITASK_NO_OPEN !== '1') {
      const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open'
      require('child_process').exec(cmd + ' http://localhost:' + port, () => {})
    }
  })
  const schedule = cron.schedule('0 7 * * *', async () => {
    try { const result = await app.locals.executeTasks(); console.log('[CRON]', result.skipped || '确认经验 +' + result.totalExp) }
    catch (e) { console.error('[CRON]', e.message) }
  }, { timezone: 'Asia/Shanghai' })
  function stop() {
    schedule.stop()
    try { fs.unlinkSync(path.join(__dirname, '.pid')) } catch {}
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return server
}
if (require.main === module) start()
module.exports = { createApp, start, dailyExp, nextRunAt }
