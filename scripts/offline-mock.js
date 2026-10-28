// Included only in the standalone design preview, never in the production page.
(() => {
  let cfg = { login: true, watch: true, coin: { enabled: true, count: 3 }, share: true }
  let loggedIn = true, running = false, lastRun = null
  const status = { login: true, watch: true, coins: 1, share: false }
  const snapshot = () => {
    const daily = (cfg.login ? 5 : 0) + (cfg.watch ? 5 : 0) + (cfg.coin.enabled ? cfg.coin.count * 10 : 0) + (cfg.share ? 5 : 0)
    return { preview: true, loggedIn, running, tasks: structuredClone(cfg), user: { name: 'Echo979', mid: '100000', face: '', coins: 128, level: 4, currentExp: 8650, nextExp: 10800, remain: 2150 }, dailyExp: daily, daysToUpgrade: daily ? Math.ceil(2150 / daily) : null, taskStatus: { ...status }, lastRun, nextRunAt: new Date(Date.now() + 86400000).toISOString() }
  }
  const response = (data, code = 200) => ({ ok: code >= 200 && code < 300, status: code, json: async () => structuredClone(data) })
  // No request is forwarded: the standalone preview works without any server.
  window.fetch = async (input, options = {}) => {
    const path = String(input).split('?')[0]
    if (path === '/api/status') return response(snapshot())
    if (path === '/api/config') {
      const data = JSON.parse(options.body)
      if (data.task === 'coin') cfg.coin = { enabled: data.enabled, count: data.count }
      else cfg[data.task] = data.enabled
      return response({ success: true, tasks: cfg })
    }
    if (path === '/api/run') {
      if (running) return response({ error: '任务正在运行' }, 409)
      running = true
      const startedAt = new Date().toISOString()
      await new Promise(resolve => setTimeout(resolve, 1000))
      const before = { ...status }, logs = ['设计预览：本次仅模拟运行，不连接 B站。']
      if (cfg.login) { status.login = true; logs.push('每日登录：已完成，跳过') }
      if (cfg.watch) { status.watch = true; logs.push('观看视频：已完成，跳过') }
      if (cfg.coin.enabled) { status.coins = Math.max(status.coins, cfg.coin.count); logs.push('模拟投币总计：' + status.coins + '/' + cfg.coin.count + ' 枚') }
      if (cfg.share) { status.share = true; logs.push('模拟分享视频：已确认完成') }
      const totalExp = (status.login && !before.login ? 5 : 0) + (status.watch && !before.watch ? 5 : 0) + Math.max(0, status.coins - before.coins) * 10 + (status.share && !before.share ? 5 : 0)
      logs.push('完成 · 本次模拟确认经验 +' + totalExp + ' EXP')
      lastRun = { startedAt, logs, totalExp, taskStatus: { ...status } }; running = false
      return response({ success: true, result: lastRun, taskStatus: { ...status } })
    }
    if (path === '/api/logout') { loggedIn = false; lastRun = null; return response({ success: true }) }
    if (path === '/api/qrcode') return response({ success: true, key: 'offline-preview', qrcode: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" rx="16" fill="#fff"/><path d="M30 30h45v45H30zm115 0h45v45h-45zM30 145h45v45H30zm67-48h25v25H97zm48 0h25v25h-25zm-48 48h25v45H97zm48 0h45v45h-45z" fill="#26272e"/><rect y="82" width="220" height="56" fill="white"/><text x="110" y="106" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#777984">设计预览 · 无需扫码</text><text x="110" y="126" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#aaa">刷新文件即可返回示例账号</text></svg>') })
    if (path === '/api/poll-login') return response({ success: false, status: 'waiting' })
    return response({ error: '离线预览不提供此操作' }, 404)
  }
})()
