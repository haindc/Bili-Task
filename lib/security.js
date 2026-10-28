const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

function localOnly(req, res, next) {
  let host
  try {
    host = new URL('http://' + req.headers.host)
    if (!LOCAL_HOSTS.has(host.hostname) || host.username || host.password || host.pathname !== '/' || host.search || host.hash) throw new Error()
    if (Number(host.port || 80) !== req.socket.localPort) throw new Error()
  } catch {
    return res.status(403).json({ success: false, error: '仅允许从本机控制台访问' })
  }
  if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== host.origin)) {
    return res.status(403).json({ success: false, error: '不允许跨站请求' })
  }
  if (req.path.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && req.headers['x-bilitask-request'] !== '1') {
    return res.status(403).json({ success: false, error: '请从控制台发起操作' })
  }
  next()
}

function avatarUrl(value) {
  if (typeof value !== 'string') throw new Error('无效的头像地址')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com'))) {
    throw new Error('无效的头像地址')
  }
  return url.href
}

module.exports = { localOnly, avatarUrl }
