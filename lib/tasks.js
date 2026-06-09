const api = require('./bilibili')

async function runTasks() {
  const cfg = api.conf()
  const tasks = cfg.tasks || {}
  const results = { login: null, watch: null, coin: null, share: null, totalExp: 0, logs: [] }

  results.logs.push(`[${new Date().toLocaleTimeString()}] 开始执行任务`)

  // 获取当前完成状态
  let status = {}
  try { status = await api.getTaskStatus() } catch (e) {}
  results.logs.push('当前完成态: 登录=' + status.login + ' 观看=' + status.watch + ' 投币=' + (status.coins||0) + '/5 分享=' + status.share)

  // 1. 每日登录
  if (tasks.login) {
    if (status.login) {
      results.logs.push('每日登录: 已完成, 跳过')
      results.login = true
    } else {
      try {
        await api.getNav()
        results.login = true
        results.totalExp += 5
        results.logs.push('每日登录: +5 EXP')
      } catch (e) {
        results.logs.push('每日登录: 失败 - ' + e.message)
      }
      await api.randDelay(800, 1500)
    }
  }

  // 2. 获取热门视频
  let videos = []
  try {
    videos = await api.getPopularVideos(15)
    results.logs.push('获取热门视频: ' + videos.length + '个')
  } catch (e) {
    results.logs.push('获取热门视频失败: ' + e.message)
  }
  if (videos.length === 0) {
    results.logs.push('无可用视频，终止')
    return results
  }

  // 3. 观看视频
  if (tasks.watch) {
    if (status.watch) {
      results.logs.push('观看视频: 已完成, 跳过')
      results.watch = true
    } else {
      try {
        await api.playHeartbeat(videos[0].bvid, videos[0].aid, 30)
        results.watch = true
        results.totalExp += 5
        results.logs.push('观看视频: +5 EXP')
      } catch (e) {
        results.logs.push('观看视频失败: ' + e.message)
      }
      await api.randDelay(1500, 3000)
    }
  }

  // 4. 投币 — 动态补足
  const coinEnabled = tasks.coin?.enabled
  const wantCoins = coinEnabled ? (tasks.coin?.count || 3) : 0
  const doneCoins = status.coins || 0
  const needCoins = Math.max(0, wantCoins - doneCoins)

  if (coinEnabled && needCoins > 0) {
    const plan = api.coinPlan(needCoins)
    results.logs.push('投币: 目标' + wantCoins + '枚, 已完成' + doneCoins + '枚, 还需' + needCoins + '枚 → 方案' + JSON.stringify(plan))

    let coinIdx = 0
    for (const coinAmount of plan) {
      let coined = false
      for (const v of videos) {
        try {
          const r = await api.coinVideo(v.bvid, coinAmount)
          if (r.success) {
            results.totalExp += coinAmount * 10
            results.logs.push('  投币 ×' + coinAmount + ' ✓ ' + (v.title || v.bvid).substring(0,25))
            coined = true
            break
          } else {
            results.logs.push('  投币 ×' + coinAmount + ' ✗ ' + (v.title || v.bvid).substring(0,20) + ' code=' + r.code)
          }
        } catch (e) {
          results.logs.push('  投币跳过: ' + e.message)
        }
        await api.randDelay(1500, 3000)
      }
      if (!coined) {
        results.logs.push('  投币 ×' + coinAmount + ': 无可用视频')
        break
      }
      coinIdx++
    }
    const totalCoined = doneCoins + coinIdx
    results.logs.push('投币总计: ' + totalCoined + '/' + wantCoins + ' 枚')
    results.coin = totalCoined
  } else if (coinEnabled) {
    results.logs.push('投币: 已完成' + wantCoins + '枚, 跳过')
    results.coin = doneCoins
  }

  // 5. 分享 + 点赞 (始终尝试，仅APP端可完成)
  if (status.share) {
      results.logs.push('分享视频: 已完成, 跳过')
      results.share = true
    } else {
      try {
        // 点赞
        await api.likeVideo(videos[0].bvid)
        await api.randDelay(1000, 2000)
        // 分享
        const sr = await api.shareVideo(videos[0].bvid)
        if (sr.success) {
          results.share = true
          results.totalExp += 5
          results.logs.push('分享视频(移动端): +5 EXP')
        } else {
          results.logs.push('分享视频失败: code=' + sr.code)
        }
      } catch (e) {
        results.logs.push('分享视频失败: ' + e.message)
      }
  }

  // 刷新完成态
  try {
    status = await api.getTaskStatus()
  } catch (e) {}

  results.logs.push('完成! 预估经验 +' + results.totalExp)
  results.logs.push('最终状态: 登录=' + status.login + ' 观看=' + status.watch + ' 投币=' + (status.coins||0) + '/5 分享=' + status.share)
  return results
}

module.exports = { runTasks }
