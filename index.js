const express = require('express')
const cron = require('node-cron')
const QRCode = require('qrcode')
const api = require('./lib/bilibili')
const { runTasks } = require('./lib/tasks')
const fs = require('fs')

const app = express()
app.use(express.json())
app.use(express.static(__dirname + '/public'))

// 进程内缓存
let taskStatus = { login: false, watch: false, coins: 0, share: false }
let lastRunResult = null

// ==================== 工具 ====================
function calcDailyExp() {
  const cfg = api.conf()
  const t = cfg.tasks || {}
  let exp = 0
  if (t.login) exp += 5
  if (t.watch) exp += 5
  if (t.coin?.enabled) exp += (t.coin.count || 3) * 10
  exp += 5 // 分享始终计入(仅APP端可完成)
  return exp
}

function daysToUpgrade(info) {
  const { level, remain } = api.calcUpgrade(info)
  const daily = calcDailyExp()
  if (daily === 0) return Infinity
  return Math.ceil(remain / daily)
}

// ==================== API 路由 ====================

// 获取登录二维码
app.get('/api/qrcode', async (req, res) => {
  try {
    const { url, key } = await api.getLoginUrl()
    const dataUrl = await QRCode.toDataURL(url, { width: 260, margin: 2 })
    res.json({ success: true, qrcode: dataUrl, key })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// 轮询扫码状态
app.get('/api/poll-login', async (req, res) => {
  try {
    const result = await api.pollQrLogin(req.query.key)
    res.json(result)
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// 获取完整状态 (用户信息 + 任务开关 + 完成态)
app.get('/api/status', async (req, res) => {
  const cfg = api.conf()
  const user = await api.checkLogin()
  if (!user) {
    return res.json({ loggedIn: false, tasks: cfg.tasks })
  }

  // 获取经验信息
  let levelInfo = { level: 0, currentExp: 0, nextExp: 0, remain: 0 }
  try {
    const space = await api.getSpaceInfo(user.mid)
    levelInfo = api.calcUpgrade(space)
  } catch (e) {
    try { levelInfo = api.calcUpgrade(user) } catch (e2) {}
  }

  // 获取任务完成状态
  try {
    const status = await api.getTaskStatus()
    Object.assign(taskStatus, status)
  } catch (e) {}

  res.json({
    loggedIn: true,
    user: {
      name: user.uname,
      face: user.face,
      mid: user.mid,
      level: levelInfo.level,
      currentExp: levelInfo.currentExp,
      nextExp: levelInfo.nextExp,
      remain: levelInfo.remain,
      coins: await api.getCoinCount()
    },
    taskStatus,
    tasks: cfg.tasks,
    dailyExp: calcDailyExp(),
    daysToUpgrade: daysToUpgrade(user),
    lastRun: lastRunResult
  })
})

// 保存任务配置
app.post('/api/config', (req, res) => {
  try {
    const cfg = api.conf()
    const { task, enabled, count } = req.body
    if (task === 'coin') {
      cfg.tasks.coin.enabled = !!enabled
      if (count !== undefined) cfg.tasks.coin.count = Math.max(1, Math.min(5, count))
    } else if (cfg.tasks.hasOwnProperty(task)) {
      cfg.tasks[task] = !!enabled
    }
    api.saveConf(cfg)
    res.json({ success: true, tasks: cfg.tasks })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// 执行任务
app.post('/api/run', async (req, res) => {
  try {
    lastRunResult = await runTasks()
    // 刷新完成状态
    try {
      const status = await api.getTaskStatus()
      Object.assign(taskStatus, status)
    } catch (e) {}
    res.json({ success: true, result: lastRunResult, taskStatus })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// 头像代理 (B站CDN防盗链)
app.get('/api/avatar', async (req, res) => {
  try {
    const url = req.query.url
    if (!url || !url.includes('hdslb.com')) return res.status(400).send('invalid')
    const r = await require('axios').get(url, {
      responseType: 'stream',
      headers: { 'Referer': 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' }
    })
    res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    r.data.pipe(res)
  } catch (e) { res.status(500).send('error') }
})

// 退出登录
app.post('/api/logout', (req, res) => {
  const cfg = api.conf()
  cfg.cookie = ''
  api.saveConf(cfg)
  taskStatus = { login: false, watch: false, coins: 0, share: false }
  res.json({ success: true })
})

// ==================== 定时任务 (每天 7:00) ====================
cron.schedule('0 7 * * *', async () => {
  console.log('[CRON] 每日任务触发 - ' + new Date().toLocaleString())
  try {
    lastRunResult = await runTasks()
    try {
      const status = await api.getTaskStatus()
      Object.assign(taskStatus, status)
    } catch (e) {}
    console.log('[CRON] 完成, 经验 +' + (lastRunResult?.totalExp || 0))
  } catch (e) {
    console.error('[CRON] 任务失败:', e.message)
  }
}, { timezone: 'Asia/Shanghai' })

// ==================== 启动 ====================
app.listen(8000, () => {
  console.log('BiliTask 已启动: http://localhost:8000')
  const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  require('child_process').exec(cmd + ' http://localhost:8000')
})
