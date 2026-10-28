'use strict'
const $ = id => document.getElementById(id)
const LEVELS = [0, 0, 200, 1500, 4500, 10800, 28800]
const number = value => Number(value || 0).toLocaleString('zh-CN')
const taskDefs = [
  { key: 'login', name: '每日登录', exp: 5, path: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>', description: '登录账号，领取每日经验' },
  { key: 'watch', name: '观看视频', exp: 5, path: '<rect x="3" y="5" width="18" height="14" rx="4"/><path d="m10 9 5 3-5 3z"/>', description: '提交观看请求，并确认任务完成状态' },
  { key: 'coin', name: '每日投币', exp: 10, path: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10m-3-8h4a2 2 0 0 1 0 4h-2a2 2 0 0 0 0 4h4"/>', description: '按今日完成数量补足目标，同时点赞' },
  { key: 'share', name: '分享视频', exp: 5, path: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m9 11 6-4m-6 6 6 4"/>', description: '尝试移动端分享，经验以实际状态为准' }
]
let state = null, activeTab = 'overview', runPending = false, savePending = false, statusRequest = null
let refreshTimer = null, qrTimer = null, loginGeneration = 0, qrController = null, pageGeneration = 0
let saveQueue = Promise.resolve()
const finePointer = matchMedia('(hover: hover) and (pointer: fine)')
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
let motionEnabled = true
const storage = {
  get(key, fallback) { try { return localStorage.getItem('bilitask-' + key) ?? fallback } catch { return fallback } },
  set(key, value) { try { localStorage.setItem('bilitask-' + key, value) } catch {} }
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme
  storage.set('darkmode', theme)
  $('themeButton').setAttribute('aria-label', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式')
}
function setAccent(hex) {
  if (!/^#[\da-f]{6}$/i.test(hex)) hex = '#e56c93'
  document.documentElement.style.setProperty('--accent', hex)
  document.documentElement.style.setProperty('--accent-rgb', [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(','))
  $('accentInput').value = hex
  storage.set('theme', hex)
}
setTheme(storage.get('darkmode', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
setAccent(storage.get('theme', '#e56c93'))
motionEnabled = storage.get('motion', 'true') === 'true'
$('motionInput').checked = motionEnabled
function updateMotion() {
  document.body.classList.toggle('pointer-enabled', motionEnabled && finePointer.matches && !reducedMotion.matches)
  if (!document.body.classList.contains('pointer-enabled')) document.querySelectorAll('.interactive-card,.magnetic').forEach(resetCard)
}
function resetCard(card) { ['--tilt-x', '--tilt-y', '--mouse-x', '--mouse-y'].forEach(p => card.style.removeProperty(p)); if (card.classList.contains('magnetic')) card.style.removeProperty('transform') }
updateMotion()
finePointer.addEventListener('change', updateMotion); reducedMotion.addEventListener('change', updateMotion)
let pointerFrame = 0, pointerEvent
function trackPointer(event) {
  if (!document.body.classList.contains('pointer-enabled')) return
  pointerEvent = event
  if (pointerFrame) return
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0
    const { clientX: x, clientY: y, target } = pointerEvent
    $('pointerGlow').style.setProperty('--pointer-x', x + 'px'); $('pointerGlow').style.setProperty('--pointer-y', y + 'px')
    const card = target.closest('.interactive-card'), button = target.closest('.magnetic')
    if (card) {
      const rect = card.getBoundingClientRect(), px = x - rect.left, py = y - rect.top
      card.style.setProperty('--mouse-x', px + 'px'); card.style.setProperty('--mouse-y', py + 'px')
      card.style.setProperty('--tilt-x', ((px / rect.width - .5) * 2.4) + 'deg')
      card.style.setProperty('--tilt-y', ((.5 - py / rect.height) * 2.4) + 'deg')
    }
    if (button && !button.disabled) {
      const r = button.getBoundingClientRect()
      button.style.transform = `translate(${(x - r.left - r.width / 2) * .07}px,${(y - r.top - r.height / 2) * .1}px)`
    }
  })
}
document.addEventListener('pointermove', trackPointer, { passive: true })
document.addEventListener('pointerout', event => {
  const card = event.target.closest('.interactive-card,.magnetic')
  if (card && !card.contains(event.relatedTarget)) resetCard(card)
}, { passive: true })
document.documentElement.addEventListener('pointerleave', () => { document.querySelectorAll('.interactive-card,.magnetic').forEach(resetCard) })

function toast(message, error = false) {
  const item = document.createElement('div'); item.className = 'toast' + (error ? ' error' : '')
  const icon = document.createElement('span'); icon.textContent = error ? '!' : '✓'; icon.setAttribute('aria-hidden', 'true')
  const text = document.createElement('span'); text.textContent = message
  item.append(icon, text); $('toastStack').append(item)
  while ($('toastStack').childElementCount > 3) $('toastStack').firstElementChild.remove()
  setTimeout(() => item.remove(), 5000)
}
function showError(message) { $('errorMessage').textContent = message; $('errorBanner').hidden = false }
async function request(path, { timeout = 20000, ...options } = {}) {
  const signal = options.signal || AbortSignal.timeout(timeout)
  const r = await fetch('/api/' + path, { ...options, signal, headers: { 'Content-Type': 'application/json', 'X-BiliTask-Request': '1', ...options.headers } })
  let result
  try { result = await r.json() } catch { throw new Error('服务器返回异常，请检查程序是否仍在运行') }
  if (!r.ok) throw new Error(result.error || '请求失败（' + r.status + '）')
  return result
}
function cancelLogin() { loginGeneration++; clearTimeout(qrTimer); qrController?.abort(); qrController = null }
function showView(name) {
  for (const view of ['loading', 'login', 'dashboard']) $(view + 'View').hidden = view !== name
  $('navigation').hidden = name !== 'dashboard'
  if (name !== 'login') cancelLogin()
}
async function loadQR() {
  cancelLogin()
  const generation = loginGeneration
  qrController = new AbortController()
  $('qrImage').hidden = true; $('qrLoading').hidden = false; $('qrMessage').textContent = '正在获取二维码…'; $('refreshQr').disabled = true
  try {
    const result = await request('qrcode', { signal: qrController.signal })
    if (generation !== loginGeneration) return
    if (!result.success) throw new Error(result.error || '二维码获取失败')
    $('qrImage').src = result.qrcode; $('qrImage').hidden = false; $('qrMessage').textContent = '请用 B站 App 扫码'
    qrTimer = setTimeout(() => pollLogin(result.key, generation), 2000)
  } catch (e) {
    if (generation !== loginGeneration) return
    $('qrMessage').textContent = '获取失败，请点击刷新重试'; toast(e.message, true)
  } finally { if (generation === loginGeneration) { $('qrLoading').hidden = true; $('refreshQr').disabled = false } }
}
async function pollLogin(key, generation) {
  if (generation !== loginGeneration) return
  try {
    const r = await request('poll-login?key=' + encodeURIComponent(key), { signal: qrController.signal })
    if (generation !== loginGeneration) return
    if (r.success) { cancelLogin(); toast('登录成功，欢迎回来'); await refreshStatus(); return }
    if (r.status === 'expired') { $('qrMessage').textContent = '二维码已过期，请刷新'; return }
    $('qrMessage').textContent = r.status === 'scanned' ? '已扫码，请在手机上确认…' : '请用 B站 App 扫码'
    qrTimer = setTimeout(() => pollLogin(key, generation), 2000)
  } catch (e) { if (generation === loginGeneration) $('qrMessage').textContent = '连接中断，请刷新二维码重试' }
}
function taskEnabled(key) { return key === 'coin' ? !!state.tasks.coin?.enabled : !!state.tasks[key] }
function targetCoins() { return state.tasks.coin?.count || 3 }
function taskDone(key) { return state.taskStatus && (key === 'coin' ? state.taskStatus.coins >= targetCoins() : state.taskStatus[key]) }
function renderCards() {
  let completed = 0, enabledCount = 0
  $('taskGrid').replaceChildren()
  for (const def of taskDefs) {
    const enabled = taskEnabled(def.key), known = !!state.taskStatus, done = enabled && taskDone(def.key)
    if (enabled) enabledCount++
    if (done) completed++
    const el = document.createElement('article'); el.className = 'task-card interactive-card' + (done ? ' done' : '') + (!enabled ? ' off' : '')
    const label = !enabled ? '已关闭' : !known ? '待确认' : done ? '已完成' : '待完成'
    // Markup below contains only fixed labels and numeric API values; external text uses textContent.
    el.innerHTML = `<div class="task-card-top"><div class="task-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${def.path}</svg></div><span class="task-state ${done ? 'done' : enabled && known ? 'pending' : ''}">${done ? '✓ ' : ''}${label}</span></div><h3>${def.name}</h3><div class="task-value">${def.key === 'coin' ? (known ? number(state.taskStatus.coins) : '—') + '<small>/ ' + number(targetCoins()) + ' 枚</small>' : '+' + def.exp + '<small>EXP</small>'}</div><div class="task-caption">${def.key === 'coin' ? '每枚 +10 EXP · 今日目标 ' + number(targetCoins()) + ' 枚' : def.key === 'share' ? '移动端模拟 · 以实际奖励为准' : done ? '今天的成长，已经记下' : enabled ? '等待今日任务执行' : '可在任务设置中重新开启'}</div><div class="task-line"><span></span></div>`
    el.querySelector('.task-line span').style.width = (done ? 100 : known && def.key === 'coin' && enabled ? Math.min(100, state.taskStatus.coins / targetCoins() * 100) : 0) + '%'
    $('taskGrid').append(el)
  }
  $('completedCount').textContent = completed + ' / ' + enabledCount
}
function renderSettings() {
  const focusedId = document.activeElement?.id
  $('settingsList').replaceChildren()
  for (const def of taskDefs) {
    const row = document.createElement('div'); row.className = 'setting-row'
    row.innerHTML = `<div class="setting-top"><div class="task-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${def.path}</svg></div><div class="setting-copy"><h3 id="label-${def.key}">${def.name}</h3><p>${def.description}</p></div><button class="switch" id="switch-${def.key}" role="switch" aria-labelledby="label-${def.key}" aria-checked="${taskEnabled(def.key)}"></button></div>`
    const control = row.querySelector('.switch'); control.disabled = runPending || state.running || savePending
    control.addEventListener('click', () => saveConfig(def.key, !taskEnabled(def.key)))
    if (def.key === 'coin') {
      const controls = document.createElement('div'); controls.className = 'coin-controls'
      controls.innerHTML = '<label for="coinCount">每日目标</label><input type="range" id="coinCount" min="1" max="5" step="1" aria-describedby="coinNote"><output id="coinOutput" for="coinCount"></output>'
      const input = controls.querySelector('input'); input.value = targetCoins(); input.disabled = !taskEnabled('coin') || runPending || state.running || savePending
      const update = () => { controls.querySelector('output').textContent = input.value + ' 枚 / +' + Number(input.value) * 10 + ' EXP' }
      update(); input.addEventListener('input', update); input.addEventListener('change', () => saveConfig('coin', taskEnabled('coin'), Number(input.value)))
      row.append(controls)
      const note = document.createElement('p'); note.id = 'coinNote'; note.className = 'setting-note'; note.textContent = '今天已投的硬币计入目标，不会因重新运行而重复补足。'; row.append(note)
    }
    $('settingsList').append(row)
  }
  if (focusedId) $(focusedId)?.focus({ preventScroll: true })
  $('settingsDaily').textContent = state.dailyExp
}
function renderLogs() {
  const result = state.lastRun
  $('logList').replaceChildren()
  $('copyLogs').disabled = !result?.logs?.length
  $('logSummary').textContent = result ? (formatTime(result.startedAt) + ' · ' + (result.skipped ? '已满级，跳过运行' : '本次确认经验 +' + number(result.totalExp) + ' EXP')) : '还没有运行记录。执行一次任务后，详细结果会显示在这里。'
  for (const log of result?.logs || []) {
    const li = document.createElement('li'); li.textContent = log
    if (/失败|未完成|未确认|异常/.test(log)) li.classList.add('log-error')
    $('logList').append(li)
  }
  const recent = $('recentRun'); recent.replaceChildren()
  if (result) {
    const icon = document.createElement('span'); icon.className = 'activity-dot'; icon.textContent = result.statusPending ? '…' : '✓'
    const text = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p')
    title.textContent = result.skipped ? '已满级，自动停止任务' : result.statusPending ? '运行结束，经验待确认' : '今日任务已运行'
    detail.textContent = formatTime(result.startedAt) + ' · 查看记录了解每项结果'; text.append(title, detail)
    const exp = document.createElement('span'); exp.className = 'exp-tag'; exp.textContent = '+' + number(result.totalExp) + ' EXP'
    recent.append(icon, text, exp)
  } else {
    const empty = document.createElement('div'); empty.className = 'empty-state'; empty.innerHTML = '<strong>今天的故事，从这里开始</strong>运行一次任务，记录你的每一点成长。'; recent.append(empty)
  }
}
function formatTime(value) { return value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai', hour12: false }).format(new Date(value)) : '—' }
function render() {
  if (!state) return
  $('previewNotice').hidden = !state.preview
  $('loadingView').hidden = true
  if (!state.loggedIn) {
    const enteringLogin = $('loginView').hidden
    showView('login')
    if (enteringLogin) loadQR()
    return
  }
  showView('dashboard')
  $('userName').textContent = state.user.name; $('userId').textContent = 'UID ' + state.user.mid
  $('avatarFallback').textContent = (state.user.name || 'B').slice(0, 1).toUpperCase()
  const avatar = state.user.face ? '/api/avatar?url=' + encodeURIComponent(state.user.face) : ''
  if (avatar && $('userFace').getAttribute('src') !== avatar) { $('userFace').hidden = false; $('userFace').src = avatar; $('avatarFallback').hidden = true }
  if (!avatar) { $('userFace').hidden = true; $('avatarFallback').hidden = false }
  const max = state.user.level >= 6, level = state.user.level, base = LEVELS[level] || 0
  const pct = max ? 100 : Math.max(0, Math.min(100, (state.user.currentExp - base) / (state.user.nextExp - base || 1) * 100))
  $('progressRing').setAttribute('stroke-dasharray', pct.toFixed(2) + ' 100')
  $('levelPercent').replaceChildren(document.createTextNode(pct.toFixed(1)), Object.assign(document.createElement('small'), { textContent: '%' }))
  $('levelRoute').textContent = max ? 'Lv.6 · 已满级' : 'Lv.' + level + ' → Lv.' + (level + 1)
  $('floatingLevel').replaceChildren(document.createTextNode('Lv. ' + level), Object.assign(document.createElement('span'), { textContent: '↗' }))
  $('dailyExpChip').textContent = '+' + state.dailyExp + ' EXP'
  $('expNumbers').textContent = number(state.user.currentExp) + ' / ' + number(state.user.nextExp) + ' EXP'
  $('heroDescription').textContent = max ? '满级成就已达成，自动任务已停止，不再消耗硬币。' : state.dailyExp ? '还差 ' + number(state.user.remain) + ' EXP，按当前计划预计 ' + number(state.daysToUpgrade) + ' 天到达 Lv.' + (level + 1) + '。' : '暂时放慢脚步。开启任务后，这里会显示你的成长计划。'
  const running = runPending || state.running
  $('heroBadge').replaceChildren(Object.assign(document.createElement('span'), { className: 'status-dot' }), document.createTextNode(max ? '满级任务已停止' : running ? '今日任务运行中' : state.dailyExp ? '自动任务已就绪' : '全部任务已关闭'))
  $('runButton').disabled = max || running || savePending || state.dailyExp === 0
  $('runLabel').textContent = max ? '已达到 Lv.6' : running ? '正在运行…' : '运行今日任务'
  $('runButton').setAttribute('aria-busy', String(running))
  $('logoutButton').disabled = running
  $('heroFootnote').textContent = running ? '任务执行中，请稍候；重复运行请求会被拦截。' : '完成状态与经验以 B站实际返回为准'
  $('nextRunText').textContent = max ? '账号已满级，每日任务将自动跳过' : !state.dailyExp ? '任务已全部关闭，每日运行时将跳过' : '下次运行：' + formatTime(state.nextRunAt)
  $('scheduleNote').textContent = state.preview ? '设计预览 · 未启用真实定时任务' : '北京时间 07:00 · 需保持程序运行'
  $('dateLabel').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' }).format(new Date()) + ' / DAILY SPACE'
  renderCards(); renderSettings(); renderLogs()
  if (state.statusError) showError('暂时无法确认任务状态：' + state.statusError)
}
function setTab(name, focus = false) {
  activeTab = name
  for (const tab of ['overview', 'settings', 'logs']) {
    $(tab + 'Panel').hidden = tab !== name
    const button = $(tab + 'Tab'); button.classList.toggle('active', tab === name); button.setAttribute('aria-selected', String(tab === name)); button.tabIndex = tab === name ? 0 : -1
  }
  const titles = { overview: ['今天，也在向前。', '小小的日常，积累成看得见的成长。'], settings: ['成长，有自己的节奏。', '选择需要的任务，其他的交给 BiliTask。'], logs: ['每一步，都看得见。', '查看执行结果，也留意那些还未确认的任务。'] }
  $('pageTitle').textContent = titles[name][0]; $('pageSubtitle').textContent = titles[name][1]
  if (focus) $(name + 'Tab').focus()
}
function scheduleRefresh() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(async () => {
    if (!document.hidden && state?.loggedIn && !savePending && activeTab !== 'settings') await refreshStatus()
    scheduleRefresh()
  }, state?.running || runPending ? 4000 : 30000)
}
async function refreshStatus() {
  if (statusRequest) return statusRequest
  const generation = pageGeneration
  $('refreshButton').disabled = true
  statusRequest = (async () => {
    try {
      const data = await request('status')
      if (generation !== pageGeneration) return
      state = data; $('errorBanner').hidden = true; render()
    } catch (e) { if (generation === pageGeneration) { showError(e.message); if (!state) $('loadingView').hidden = true } }
    finally { $('refreshButton').disabled = false; statusRequest = null }
  })()
  return statusRequest
}
function saveConfig(task, enabled, count) {
  savePending = true; $('saveIndicator').textContent = '正在保存…'; render()
  saveQueue = saveQueue.then(async () => {
    try {
      await request('config', { method: 'POST', body: JSON.stringify({ task, enabled, ...(task === 'coin' ? { count: count ?? targetCoins() } : {}) }) })
      await statusRequest
      await refreshStatus()
      $('saveIndicator').textContent = '已保存'; toast('任务设置已保存')
    } catch (e) { $('saveIndicator').textContent = '保存失败，请重试'; toast(e.message, true) }
    finally { savePending = false; render() }
  })
}
async function runToday() {
  if (runPending || state?.running || savePending || !state?.loggedIn) return
  runPending = true; render(); scheduleRefresh(); toast('开始运行，完成后会更新任务状态')
  try {
    const res = await request('run', { method: 'POST', timeout: 300000 })
    if (res.result) state.lastRun = res.result
    toast(res.result?.skipped ? '账号已满级，任务已跳过' : '运行已结束，请查看各项任务状态')
    await statusRequest; await refreshStatus()
  } catch (e) { toast(e.name === 'TimeoutError' ? '等待超时，任务可能仍在运行，请刷新状态确认' : e.message, true); await refreshStatus() }
  finally { runPending = false; render(); scheduleRefresh() }
}
async function logout() {
  if (runPending || state?.running) return
  try {
    await request('logout', { method: 'POST' })
    pageGeneration++; state = null; clearTimeout(refreshTimer); cancelLogin(); $('errorBanner').hidden = true; setTab('overview'); showView('login'); loadQR(); toast('已退出登录')
  } catch (e) { toast(e.message, true) }
}
$('navigation').addEventListener('click', e => { const tab = e.target.closest('[data-tab]'); if (tab) setTab(tab.dataset.tab) })
$('navigation').addEventListener('keydown', e => {
  const names = ['overview', 'settings', 'logs'], index = names.indexOf(activeTab)
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    e.preventDefault(); setTab(e.key === 'Home' ? names[0] : e.key === 'End' ? names[2] : names[(index + (e.key === 'ArrowRight' ? 1 : 2)) % 3], true)
  }
})
document.querySelectorAll('[data-open-tab]').forEach(button => button.addEventListener('click', () => setTab(button.dataset.openTab, true)))
$('themeButton').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'))
function closeAppearance() { $('appearancePanel').hidden = true; $('appearanceButton').setAttribute('aria-expanded', 'false') }
$('appearanceButton').addEventListener('click', () => { const open = $('appearancePanel').hidden; $('appearancePanel').hidden = !open; $('appearanceButton').setAttribute('aria-expanded', String(open)) })
$('closeAppearance').addEventListener('click', () => { closeAppearance(); $('appearanceButton').focus() })
document.addEventListener('click', e => { if (!$('appearancePanel').contains(e.target) && !$('appearanceButton').contains(e.target)) closeAppearance() })
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('appearancePanel').hidden) { closeAppearance(); $('appearanceButton').focus() } })
$('accentInput').addEventListener('input', e => setAccent(e.target.value))
$('motionInput').addEventListener('change', e => { motionEnabled = e.target.checked; storage.set('motion', String(motionEnabled)); updateMotion() })
$('resetAppearance').addEventListener('click', () => { setAccent('#e56c93'); motionEnabled = true; $('motionInput').checked = true; storage.set('motion', 'true'); updateMotion(); toast('已恢复默认外观') })
$('runButton').addEventListener('click', runToday)
$('refreshButton').addEventListener('click', refreshStatus)
$('retryStatus').addEventListener('click', refreshStatus)
$('refreshQr').addEventListener('click', loadQR)
$('logoutButton').addEventListener('click', () => $('logoutDialog').showModal())
$('logoutDialog').addEventListener('close', () => { if ($('logoutDialog').returnValue === 'confirm') logout() })
$('copyLogs').addEventListener('click', async () => { try { await navigator.clipboard.writeText(state.lastRun.logs.join('\n')); toast('日志已复制') } catch { toast('无法访问剪贴板，可手动选择日志复制', true) } })
$('userFace').addEventListener('error', () => { $('userFace').hidden = true; $('avatarFallback').hidden = false })
document.addEventListener('visibilitychange', () => { if (!document.hidden && state?.loggedIn && !savePending && activeTab !== 'settings') refreshStatus() })
refreshStatus().then(scheduleRefresh)
