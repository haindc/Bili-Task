const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTaskRunner } = require('../lib/tasks')
const { calcUpgrade, coinPlan } = require('../lib/bilibili')
function fixture(overrides = {}) {
  let cfg = { tasks: { login: true, watch: true, coin: { enabled: true, count: 5 }, share: true } }
  const status = { login: true, watch: false, coins: 0, share: false }
  const calls = { coins: [], watches: 0, shares: 0 }
  const api = {
    conf: () => cfg, calcUpgrade, coinPlan,
    checkLogin: async () => ({ isLogin: true, level_info: { current_level: 4, current_exp: 5000 } }),
    getTaskStatus: async () => ({ ...status }), getPopularVideos: async () => [1, 2, 3, 4].map(i => ({ bvid: 'v' + i, aid: i, title: 'Video ' + i })),
    playHeartbeat: async () => { calls.watches++; status.watch = true; return true },
    coinVideo: async (bvid, count) => { calls.coins.push({ bvid, count }); status.coins += count; return { success: true } },
    shareVideo: async () => { calls.shares++; status.share = true; return { success: true } }, randDelay: async () => {}, ...overrides
  }
  return { api, calls, status, setConfig: value => { cfg = value }, ...createTaskRunner(api) }
}
test('coin batches count actual coins, use distinct videos, and confirm experience', async () => {
  const f = fixture(), result = await f.runTasks()
  assert.equal(result.coin, 5); assert.deepEqual(f.calls.coins.map(x => x.count), [2, 2, 1])
  assert.equal(new Set(f.calls.coins.map(x => x.bvid)).size, 3)
  assert.equal(result.totalExp, 60); assert.equal(result.watch, true); assert.equal(result.share, true)
})
test('only tops up existing daily coin count; second run does not spend again', async () => {
  const f = fixture(); f.status.coins = 3
  const first = await f.runTasks(); assert.equal(first.coin, 5); assert.equal(f.calls.coins.length, 1); assert.equal(f.calls.coins[0].count, 2)
  const second = await f.runTasks(); assert.equal(second.totalExp, 0); assert.equal(f.calls.coins.length, 1)
})
test('concurrent manual/scheduled execution is rejected while the shared runner is locked', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture({ checkLogin: async () => { await gate; return { level: 4 } } })
  const first = f.runTasks(); assert.equal(f.isRunning(), true)
  await assert.rejects(f.runTasks(), { code: 'TASK_RUNNING', statusCode: 409 })
  release(); await first; assert.equal(f.calls.coins.reduce((s, c) => s + c.count, 0), 5); assert.equal(f.isRunning(), false)
})
test('level 6 halts all tasks, including spending, before requesting daily state', async () => {
  const f = fixture({ checkLogin: async () => ({ level_info: { current_level: 6 } }), getTaskStatus: async () => assert.fail('must not run') })
  const result = await f.runTasks(); assert.equal(result.skipped, 'MAX_LEVEL'); assert.equal(f.calls.coins.length, 0)
})
test('heartbeat false or rejection never marks watch complete or grants experience', async () => {
  for (const playHeartbeat of [async () => false, async () => { throw new Error('network error') }]) {
    const f = fixture({ playHeartbeat }); f.setConfig({ tasks: { watch: true } })
    const r = await f.runTasks(); assert.equal(r.watch, false); assert.equal(r.totalExp, 0)
  }
})
test('disabled tasks cause no video or interaction requests', async () => {
  const f = fixture({ getPopularVideos: async () => assert.fail('disabled tasks should not fetch videos') })
  f.setConfig({ tasks: { login: false, watch: false, coin: { enabled: false }, share: false } })
  const r = await f.runTasks(); assert.equal(r.totalExp, 0); assert.equal(f.calls.shares, 0); assert.equal(f.calls.coins.length, 0)
})
test('unknown daily status aborts before spending; lock releases on failure', async () => {
  const f = fixture({ getTaskStatus: async () => { throw new Error('unknown state') } })
  await assert.rejects(f.runTasks(), /unknown state/); assert.equal(f.calls.coins.length, 0); assert.equal(f.isRunning(), false)
})
test('logged-out execution aborts before tasks', async () => {
  const f = fixture({ checkLogin: async () => null }); await assert.rejects(f.runTasks(), { code: 'LOGIN_REQUIRED' }); assert.equal(f.calls.coins.length, 0)
})
test('ambiguous coin timeout stops attempts instead of risking another debit', async () => {
  let attempts = 0
  const f = fixture({ coinVideo: async () => { attempts++; throw new Error('timeout') } })
  const r = await f.runTasks(); assert.equal(attempts, 1); assert.equal(r.coin, 0); assert.match(r.logs.join('\n'), /停止后续投币/)
})
test('successful submission with delayed rewards is not reported as confirmed EXP', async () => {
  const f = fixture({ playHeartbeat: async () => true }); f.setConfig({ tasks: { watch: true } })
  const r = await f.runTasks(); assert.equal(r.estimatedExp, 5); assert.equal(r.totalExp, 0); assert.equal(r.watch, false)
})
test('final reward read failure is explicit and does not prevent mutex cleanup', async () => {
  let reads = 0
  const f = fixture({ getTaskStatus: async () => { if (reads++) throw new Error('unavailable'); return { login: true, watch: true, coins: 5, share: true } } })
  const r = await f.runTasks(); assert.equal(r.statusPending, true); assert.equal(f.isRunning(), false)
})
test('successful coin debit is remembered when reward status is delayed', async () => {
  let spent = 0
  const f = fixture({ coinVideo: async (bvid, amount) => { spent += amount; return { success: true } } })
  f.setConfig({ tasks: { coin: { enabled: true, count: 3 } } })
  assert.equal((await f.runTasks()).coin, 3)
  assert.equal((await f.runTasks()).coin, 3)
  assert.equal(spent, 3)
})
test('ambiguous debit stays paused on subsequent runs in the same process/day', async () => {
  let attempts = 0
  const f = fixture({ coinVideo: async () => { attempts++; throw new Error('timeout') } })
  await f.runTasks(); await f.runTasks(); assert.equal(attempts, 1)
})
