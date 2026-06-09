const axios = require('axios')
const fs = require('fs')
const querystring = require('querystring')

const API = 'https://api.bilibili.com'
const PASSPORT = 'https://passport.bilibili.com'
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
const APP_UA = 'Mozilla/5.0 (Linux; Android 13; SM-G9980) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile BiliApp/7.78.0'

function conf() { return JSON.parse(fs.readFileSync(__dirname + '/../config.json', 'utf8')) }
function saveConf(cfg) { fs.writeFileSync(__dirname + '/../config.json', JSON.stringify(cfg, null, 2)) }

function baseHeaders(useApp = false) {
  return {
    'User-Agent': useApp ? APP_UA : WEB_UA,
    'Referer': 'https://www.bilibili.com/',
    'Cookie': conf().cookie
  }
}

function videoHeaders(bvid, useApp = false) {
  return {
    'User-Agent': useApp ? APP_UA : WEB_UA,
    'Referer': 'https://www.bilibili.com/video/' + bvid + '/',
    'Origin': 'https://www.bilibili.com',
    'Cookie': conf().cookie,
    'Content-Type': 'application/x-www-form-urlencoded'
  }
}

function randDelay(min, max) {
  const ms = min + Math.random() * (max - min)
  return new Promise(r => setTimeout(r, ms))
}

// ==================== 扫码登录 ====================
async function getLoginUrl() {
  const r = await axios.get(PASSPORT + '/x/passport-login/web/qrcode/generate', { headers: baseHeaders() })
  return { url: r.data.data.url, key: r.data.data.qrcode_key }
}

async function pollQrLogin(key) {
  const r = await axios.get(PASSPORT + '/x/passport-login/web/qrcode/poll', {
    params: { qrcode_key: key },
    headers: baseHeaders()
  })
  const d = r.data.data
  if (d.code === 0) {
    const raw = r.headers['set-cookie'] || []
    const cookies = raw.map(c => c.split(';')[0]).filter(c => c.includes('=')).join('; ')
    const cfg = conf()
    cfg.cookie = cookies
    saveConf(cfg)
    return { success: true, cookie: cookies }
  }
  if (d.code === 86090) return { success: false, status: 'scanned' }
  if (d.code === 86101) return { success: false, status: 'waiting' }
  return { success: false, status: 'expired' }
}

// ==================== 用户信息 ====================
async function getNav() {
  const r = await axios.get(API + '/x/web-interface/nav', { headers: baseHeaders() })
  return r.data.data
}

async function getSpaceInfo(mid) {
  const r = await axios.get(API + '/x/space/wbi/acc/info', { params: { mid }, headers: baseHeaders() })
  return r.data.data
}

async function getCoinCount() {
  const nav = await getNav()
  return nav.money || 0
}

async function getTaskStatus() {
  try {
    const r = await axios.get(API + '/x/member/web/exp/reward', {
      headers: {
        'User-Agent': WEB_UA,
        'Referer': 'https://account.bilibili.com/account/home',
        'Origin': 'https://account.bilibili.com',
        'Cookie': conf().cookie
      }
    })
    const d = r.data.data || {}
    return {
      login: !!d.login,
      watch: !!d.watch,
      coins: Math.round((d.coins || 0) / 10),
      share: !!d.share
    }
  } catch (e) {
    return { login: false, watch: false, coins: 0, share: false }
  }
}

async function checkLogin() {
  try {
    const nav = await getNav()
    return nav.isLogin ? nav : null
  } catch { return null }
}

// ==================== 热门视频 ====================
async function getPopularVideos(count = 10) {
  const r = await axios.get(API + '/x/web-interface/popular', {
    headers: baseHeaders(), params: { ps: count, pn: 1 }
  })
  return (r.data.data.list || []).map(v => ({ bvid: v.bvid, aid: v.aid, title: v.title }))
}

// ==================== 视频互动 ====================
async function playHeartbeat(bvid, aid, playedTime = 30) {
  try {
    await axios.post(API + '/x/click-interface/web/heartbeat',
      querystring.stringify({ bvid, aid, played_time: playedTime, real_played_time: playedTime }),
      { headers: videoHeaders(bvid) })
    return true
  } catch (e) { return false }
}

async function likeVideo(bvid) {
  const r = await axios.post(API + '/x/web-interface/archive/like',
    querystring.stringify({ bvid, type: 1, csrf: getCsrf() }),
    { headers: videoHeaders(bvid) })
  return r.data.code === 0
}

async function shareVideo(bvid) {
  const r = await axios.post(API + '/x/web-interface/share/add',
    querystring.stringify({ bvid, platform: 'android', csrf: getCsrf() }),
    { headers: videoHeaders(bvid, true) })
  return { success: r.data.code === 0, code: r.data.code, message: r.data.message || '' }
}

async function coinVideo(bvid, count = 1) {
  const r = await axios.post(API + '/x/web-interface/coin/add',
    querystring.stringify({ bvid, multiply: count, csrf: getCsrf(), select_like: 1 }),
    { headers: videoHeaders(bvid) })
  return { success: r.data.code === 0, code: r.data.code, message: r.data.message || '' }
}

function getCsrf() {
  const cookie = conf().cookie
  const m = cookie.match(/bili_jct=([^;]+)/)
  return m ? m[1] : ''
}

// ==================== 经验等级表 ====================
const LEVEL_EXP = [0, 0, 200, 1500, 4500, 10800, 28800]

function calcUpgrade(info) {
  const lv = info.level_info?.current_level || info.level || 1
  const exp = info.level_info?.current_exp || info.level_exp?.current_exp || 0
  const next = LEVEL_EXP[lv + 1] || LEVEL_EXP[lv]
  const remain = next - exp
  return { level: lv, currentExp: exp, nextExp: next, remain }
}

// 按剩余币数计算投币方案
function coinPlan(remaining) {
  if (remaining <= 0) return []
  if (remaining === 1) return [1]
  if (remaining === 2) return [2]
  if (remaining === 3) return [2, 1]
  if (remaining === 4) return [2, 2]
  return [2, 2, 1] // 5
}

module.exports = {
  getLoginUrl, pollQrLogin, getNav, getSpaceInfo, checkLogin, getTaskStatus,
  getPopularVideos, playHeartbeat, likeVideo, shareVideo, coinVideo,
  calcUpgrade, randDelay, getCoinCount, coinPlan, conf, saveConf, LEVEL_EXP
}
