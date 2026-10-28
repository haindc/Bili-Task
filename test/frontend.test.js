const { test } = require('node:test')
const assert = require('node:assert/strict')
const { JSDOM, VirtualConsole } = require('jsdom')
const { buildPreview } = require('../scripts/build-preview')
async function fixture(t, saved = {}) {
  const errors = [], virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => errors.push(error))
  const dom = new JSDOM(buildPreview(), { url: 'http://localhost:8000', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(w) {
      w.structuredClone = structuredClone; w.AbortSignal.timeout = AbortSignal.timeout
      w.matchMedia = q => ({ matches: q.includes('fine'), addEventListener() {} })
      for (const [key, value] of Object.entries(saved)) w.localStorage.setItem('bilitask-' + key, value)
    }
  })
  t.after(() => dom.window.close())
  await wait(() => !dom.window.document.getElementById('dashboardView').hidden)
  return { window: dom.window, $: id => dom.window.document.getElementById(id), errors, dom }
}
async function wait(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)) } throw new Error('UI did not reach expected state') }
test('saved appearance initializes without a TDZ error; preview renders correct progress', async t => {
  const { $, window, errors } = await fixture(t, { theme: '#537ac4', darkmode: 'dark' })
  assert.equal(window.document.documentElement.style.getPropertyValue('--accent'), '#537ac4')
  assert.equal(window.document.documentElement.dataset.theme, 'dark'); assert.equal($('completedCount').textContent, '2 / 4'); assert.equal($('levelPercent').textContent, '65.9%'); assert.equal(errors.length, 0)
})
test('tabs support keyboard navigation and share can be disabled and saved', async t => {
  const { $, window, errors } = await fixture(t)
  $('overviewTab').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  assert.equal($('settingsTab').getAttribute('aria-selected'), 'true'); assert.equal($('settingsPanel').hidden, false)
  $('switch-share').click(); await wait(() => $('saveIndicator').textContent === '已保存')
  assert.equal($('switch-share').getAttribute('aria-checked'), 'false'); assert.equal($('settingsDaily').textContent, '40'); assert.equal(errors.length, 0)
})
test('run stays disabled through refresh, then renders confirmed results and safe text logs', async t => {
  const { $, window, errors } = await fixture(t)
  $('runButton').click(); assert.equal($('runButton').disabled, true)
  $('refreshButton').click(); await new Promise(r => setTimeout(r, 30)); assert.equal($('runButton').disabled, true)
  await wait(() => !$('runButton').disabled)
  assert.equal($('completedCount').textContent, '4 / 4'); assert.match($('logSummary').textContent, /25 EXP/)
  const original = window.fetch
  window.fetch = async (input, opts) => {
    const r = await original(input, opts), data = await r.json()
    if (String(input) === '/api/status') data.lastRun.logs = ['<img src=x onerror="alert(1)">']
    return { ok: true, json: async () => data }
  }
  $('refreshButton').click(); await wait(() => $('logList').textContent.includes('<img'))
  assert.equal($('logList').querySelector('img'), null); assert.equal(errors.length, 0)
})
test('failed network requests show recoverable feedback and do not corrupt task state', async t => {
  const { $, window } = await fixture(t)
  const original = window.fetch; window.fetch = async () => { throw new Error('offline') }
  $('refreshButton').click(); await wait(() => !$('errorBanner').hidden); assert.match($('errorMessage').textContent, /offline/)
  window.fetch = original; $('retryStatus').click(); await wait(() => $('errorBanner').hidden); assert.equal($('completedCount').textContent, '2 / 4')
})
