// Explicit design preview. All Bilibili operations are simulated in memory.
const { createApp } = require('../index')
const { calcUpgrade, coinPlan } = require('../lib/bilibili')
let config = { cookie: 'preview-only', tasks: { login: true, watch: true, coin: { enabled: true, count: 3 }, share: true } }
let status = { login: true, watch: true, coins: 1, share: false }
const api = {
  conf: () => structuredClone(config), saveConf: value => { config = structuredClone(value) },
  checkLogin: async () => config.cookie ? { uname: 'Echo979', mid: '100000', money: 128, face: '', level_info: { current_level: 4, current_exp: 8650 } } : null,
  getNav: async () => api.checkLogin(), calcUpgrade, coinPlan,
  getTaskStatus: async () => ({ ...status }), getPopularVideos: async () => [{ bvid: 'preview-1', aid: 1, title: '设计预览 · 示例视频' }, { bvid: 'preview-2', aid: 2, title: '设计预览 · 示例视频 2' }, { bvid: 'preview-3', aid: 3, title: '设计预览 · 示例视频 3' }],
  coinVideo: async (bvid, count) => { status.coins += count; return { success: true } },
  playHeartbeat: async () => { status.watch = true; return true },
  shareVideo: async () => { status.share = true; return { success: true } },
  randDelay: async () => new Promise(resolve => setTimeout(resolve, 500)),
  getLoginUrl: async () => ({ url: 'BiliTask design preview: this QR is not a Bilibili login.', key: 'preview-key' }),
  pollQrLogin: async () => ({ success: false, status: 'waiting' })
}
const port = Number(process.env.PORT || 8001)
createApp({ api, preview: true }).listen(port, '127.0.0.1', () => console.log('Design preview: http://localhost:' + port + ' (simulated data; no real Bilibili operations)'))
