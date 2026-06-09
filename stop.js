const fs = require('fs')
const path = require('path')

try {
  const pid = fs.readFileSync(path.join(__dirname, '.pid'), 'utf8').trim()
  process.kill(pid, 'SIGTERM')
  console.log('BiliTask 已停止')
} catch (e) {
  console.log('未找到运行中的进程 (尝试 kill 端口 8000)')
  try {
    const { execSync } = require('child_process')
    const cmd = process.platform === 'win32'
      ? 'for /f "tokens=5" %a in (\'netstat -ano ^| findstr :8000\') do taskkill /PID %a /F'
      : "lsof -t -i:8000 | xargs kill 2>/dev/null"
    execSync(cmd, { stdio: 'ignore' })
    console.log('已停止端口 8000')
  } catch (e2) {
    console.log('无运行进程')
  }
}
