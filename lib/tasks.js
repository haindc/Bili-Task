const defaultApi = require('./bilibili')

function taskError(message, code, statusCode) { return Object.assign(new Error(message), { code, statusCode }) }

function createTaskRunner(api = defaultApi) {
  let running = false
  const coinLedger = new Map()
  async function runTasks() {
    if (running) throw taskError('任务正在运行，请等待完成', 'TASK_RUNNING', 409)
    running = true
    const results = { login: null, watch: null, coin: null, share: null, totalExp: 0, estimatedExp: 0, logs: [], startedAt: new Date().toISOString() }
    try {
      const cfg = api.conf(), tasks = cfg.tasks || {}
      const user = await api.checkLogin()
      if (!user) throw taskError('请先扫码登录', 'LOGIN_REQUIRED', 401)
      if (api.calcUpgrade(user).level >= 6) {
        results.skipped = 'MAX_LEVEL'
        results.logs.push('账号已满级，已停止每日任务，不再投币。')
        return results
      }
      const before = await api.getTaskStatus()
      const status = { ...before }
      const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
      const ledgerKey = day + ':' + (user.mid ?? user.uname ?? 'account')
      for (const key of coinLedger.keys()) if (!key.startsWith(day + ':')) coinLedger.delete(key)
      const ledger = coinLedger.get(ledgerKey) || { minimum: 0, uncertain: false }
      ledger.minimum = Math.max(ledger.minimum, status.coins)
      coinLedger.set(ledgerKey, ledger)
      results.logs.push('开始执行 · 已确认今日任务状态')
      if (tasks.login) {
        results.login = status.login
        results.logs.push(status.login ? '每日登录：已完成，跳过' : '每日登录：已登录，等待经验状态确认')
      }
      const target = Math.max(1, Math.min(5, Math.trunc(Number(tasks.coin?.count) || 3)))
      const needCoins = tasks.coin?.enabled && !ledger.uncertain ? Math.max(0, target - ledger.minimum) : 0
      const needsVideos = (tasks.watch && !status.watch) || needCoins > 0 || (tasks.share && !status.share)
      const videos = needsVideos ? await api.getPopularVideos(15) : []
      if (needsVideos && !videos.length) throw new Error('没有可用视频，请稍后重试')
      if (tasks.watch) {
        if (status.watch) { results.watch = true; results.logs.push('观看视频：已完成，跳过') }
        else {
          try {
            const success = await api.playHeartbeat(videos[0].bvid, videos[0].aid, 30)
            results.watch = false
            if (!success) results.logs.push('观看视频：接口未接受请求，未记为完成')
            else { results.estimatedExp += 5; results.logs.push('观看视频：请求已提交，等待经验确认') }
          } catch (e) { results.watch = false; results.logs.push('观看视频失败：' + e.message) }
          await api.randDelay(1500, 3000)
        }
      }
      if (tasks.coin?.enabled) {
        let uncertain = false
        const used = new Set()
        for (const amount of api.coinPlan(needCoins)) {
          let succeeded = false
          for (const video of videos) {
            if (used.has(video.bvid)) continue
            try {
              const r = await api.coinVideo(video.bvid, amount)
              if (r.success) {
                ledger.minimum += amount
                used.add(video.bvid)
                results.estimatedExp += amount * 10
                results.logs.push('投币 ×' + amount + ' 成功 · ' + (video.title || video.bvid))
                succeeded = true
                await api.randDelay(1500, 3000)
                break
              }
              results.logs.push('投币未完成 · ' + (r.message || 'code=' + r.code))
              if ([-101, -111, -403].includes(r.code)) { uncertain = true; break }
            } catch (e) {
              // A timeout may follow a successful debit. Never retry another video blindly.
              uncertain = true
              ledger.uncertain = true
              results.logs.push('投币结果未确认，已停止后续投币，请稍后刷新状态。' + e.message)
              break
            }
            await api.randDelay(1500, 3000)
          }
          if (!succeeded || uncertain) break
        }
        results.coin = ledger.minimum
        if (ledger.uncertain) results.logs.push('今日存在结果未确认的投币，已暂停本进程今日自动重试，请检查 B站记录。')
        results.logs.push('投币总计：' + results.coin + '/' + target + ' 枚')
      }
      if (tasks.share) {
        if (status.share) { results.share = true; results.logs.push('分享视频：已完成，跳过') }
        else {
          try {
            const r = await api.shareVideo(videos[0].bvid)
            results.share = false
            if (r.success) { results.estimatedExp += 5; results.logs.push('分享视频：请求已提交，以经验状态为准') }
            else results.logs.push('分享视频未完成：' + (r.message || 'code=' + r.code))
          } catch (e) { results.share = false; results.logs.push('分享视频失败：' + e.message) }
        }
      }
      try {
        const after = await api.getTaskStatus()
        ledger.minimum = Math.max(ledger.minimum, after.coins)
        results.taskStatus = after
        if (tasks.login) results.login = after.login
        if (tasks.watch) results.watch = after.watch
        if (tasks.share) results.share = after.share
        results.totalExp = (after.login && !before.login ? 5 : 0) + (after.watch && !before.watch ? 5 : 0) +
          Math.max(0, after.coins - before.coins) * 10 + (after.share && !before.share ? 5 : 0)
        results.logs.push('完成 · 本次确认经验 +' + results.totalExp + ' EXP（接口状态可能延迟）')
      } catch (e) {
        results.statusPending = true
        results.logs.push('任务已结束，暂时无法确认经验：' + e.message)
      }
      return results
    } finally { running = false }
  }
  return { runTasks, isRunning: () => running }
}
module.exports = { ...createTaskRunner(), createTaskRunner }
