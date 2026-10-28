const axios = require('axios')
const fs = require('fs')
const path = require('path')
const querystring = require('querystring')

const API = 'https://api.bilibili.com'
const PASSPORT = 'https://passport.bilibili.com'
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
const APP_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Mobile BiliApp/7.78.0'
const LEVEL_EXP = [0, 0, 200, 1500, 4500, 10800, 28800]
const configPath = path.join(__dirname, '..', 'config.json')

function conf() { return JSON.parse(fs.readFileSync(configPath, 'utf8')) }
function saveConf(cfg) {
  const temp = configPath + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  fs.renameSync(temp, configPath)
}
function calcUpgrade(info) {
  const level = Math.max(0, Math.min(6, Number(info.level_info?.current_level ?? info.level ?? 0)))
  const currentExp = Math.max(0, Number(info.level_info?.current_exp ?? info.level_exp?.current_exp ?? 0))
  const nextExp = level >= 6 ? currentExp : LEVEL_EXP[level + 1]
  return { level, currentExp, nextExp, remain: Math.max(0, nextExp - currentExp) }
}
function coinPlan(remaining) {
  const plan = []
  for (let n = Math.max(0, Math.min(5, Math.trunc(remaining))); n > 0; n -= 2) plan.push(Math.min(2, n))
  return plan
}
function randDelay(min, max) { return new Promise(resolve => setTimeout(resolve, min + Math.random() * (max - min))) }

function createClient({ http = axios.create({ timeout: 15000 }), readConfig = conf, writeConfig = saveConf } = {}) {
  function headers(bvid, app = false) {
    return {
      'User-Agent': app ? APP_UA : WEB_UA,
      Referer: bvid ? 'https://www.bilibili.com/video/' + bvid + '/' : 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com', Cookie: readConfig().cookie || ''
    }
  }
  function csrf() { return (readConfig().cookie || '').match(/(?:^|;\s*)bili_jct=([^;]+)/)?.[1] || '' }
  function data(response) {
    const body = response.data
    if (body?.code !== 0 || body.data == null) {
      const error = new Error(body?.message || 'B站接口返回异常')
      error.code = body?.code
      throw error
    }
    return body.data
  }
  async function post(endpoint, values, bvid, app = false) {
    const r = await http.post(API + endpoint, querystring.stringify(values), {
      headers: { ...headers(bvid, app), 'Content-Type': 'application/x-www-form-urlencoded' }
    })
    return { success: r.data?.code === 0, code: r.data?.code, message: r.data?.message || '' }
  }
  async function getNav() { return data(await http.get(API + '/x/web-interface/nav', { headers: headers() })) }
  async function checkLogin() {
    try { const nav = await getNav(); return nav.isLogin ? nav : null } catch (error) {
      if (error.code === -101) return null
      throw error
    }
  }
  async function getTaskStatus() {
    const d = data(await http.get(API + '/x/member/web/exp/reward', {
      headers: { ...headers(), Referer: 'https://account.bilibili.com/account/home', Origin: 'https://account.bilibili.com' }
    }))
    if (!['login', 'watch', 'coins', 'share'].every(key => Object.hasOwn(d, key)) ||
        !Number.isFinite(Number(d.coins)) || Number(d.coins) < 0) throw new Error('无法确认每日任务状态，本次未继续执行')
    return { login: !!d.login, watch: !!d.watch, coins: Math.min(5, Math.floor(Number(d.coins) / 10)), share: !!d.share }
  }
  async function getLoginUrl() {
    const d = data(await http.get(PASSPORT + '/x/passport-login/web/qrcode/generate', { headers: headers() }))
    return { url: d.url, key: d.qrcode_key }
  }
  async function pollQrLogin(key) {
    const r = await http.get(PASSPORT + '/x/passport-login/web/qrcode/poll', { params: { qrcode_key: key }, headers: headers() })
    const d = data(r)
    if (d.code === 0) {
      const cookies = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).filter(c => c.includes('=')).join('; ')
      if (!/(?:^|;\s*)SESSDATA=/.test(cookies) || !/(?:^|;\s*)bili_jct=/.test(cookies)) throw new Error('登录凭据不完整，请重新扫码')
      writeConfig({ ...readConfig(), cookie: cookies })
      return { success: true }
    }
    return { success: false, status: d.code === 86090 ? 'scanned' : d.code === 86101 ? 'waiting' : 'expired' }
  }
  async function getPopularVideos(count = 15) {
    const d = data(await http.get(API + '/x/web-interface/popular', { headers: headers(), params: { ps: count, pn: 1 } }))
    return (d.list || []).map(v => ({ bvid: v.bvid, aid: v.aid, title: v.title }))
  }
  async function playHeartbeat(bvid, aid, playedTime = 30) {
    const r = await post('/x/click-interface/web/heartbeat', { bvid, aid, played_time: playedTime, real_played_time: playedTime, csrf: csrf() }, bvid)
    return r.success
  }
  return {
    conf: readConfig, saveConf: writeConfig, getNav, checkLogin, getTaskStatus, getLoginUrl, pollQrLogin, getPopularVideos, playHeartbeat,
    getCoinCount: async () => (await getNav()).money || 0,
    coinVideo: (bvid, count = 1) => post('/x/web-interface/coin/add', { bvid, multiply: count, csrf: csrf(), select_like: 1 }, bvid),
    shareVideo: bvid => post('/x/web-interface/share/add', { bvid, platform: 'android', csrf: csrf() }, bvid, true),
    calcUpgrade, coinPlan, randDelay, LEVEL_EXP
  }
}
module.exports = { ...createClient(), createClient }
