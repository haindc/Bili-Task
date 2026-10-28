const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
function buildPreview() {
  let html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
  html = html.replace('<link rel="stylesheet" href="/style.css">', '<style>' + fs.readFileSync(path.join(root, 'public/style.css'), 'utf8') + '</style>')
    .replace('<script src="/app.js" defer></script>', '')
    .replace('href="/icon.svg"', 'href="data:image/svg+xml,' + encodeURIComponent(fs.readFileSync(path.join(root, 'public/icon.svg'), 'utf8')) + '"')
    .replace('class="brand" href="/"', 'class="brand" href="#main"')
    .replace('</body>', '<script>' + fs.readFileSync(path.join(root, 'scripts/offline-mock.js'), 'utf8') + '</script><script>' + fs.readFileSync(path.join(root, 'public/app.js'), 'utf8') + '</script></body>')
  return html
}
if (require.main === module) {
  const output = process.argv[2] || path.join(root, '..', 'BiliTask-preview.html')
  fs.writeFileSync(output, buildPreview()); console.log(output)
}
module.exports = { buildPreview }
