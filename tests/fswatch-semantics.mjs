// NodeTreeWatcher 核心语义验证：fs.watch recursive 在本机（Windows）上的行为
// 直接以 dist 编译产物运行（NodeTreeWatcher 在 watcher.js 内，但该模块 require('vscode')——
// 这里不 import 编译产物，而是复制同款 watch 调用验证平台语义）。
const fs = require('node:fs')
const path = require('node:path')

const root = fs.mkdtempSync(path.join(process.cwd(), '.watch-test-'))
fs.mkdirSync(path.join(root, 'sub'), { recursive: true })

const events = []
const watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
  events.push({ eventType, filename })
})
watcher.on('error', (e) => events.push({ error: String(e) }))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const run = async () => {
  await sleep(400) // watcher 就绪
  fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'one') // create（rename 事件）
  await sleep(300)
  fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'two') // change（change 事件）
  await sleep(300)
  fs.unlinkSync(path.join(root, 'sub', 'a.txt')) // delete（rename 事件）
  await sleep(500)
  watcher.close()
  console.log(JSON.stringify(events, null, 2))
  // 断言：有 sub 内文件的 rename（create/delete）与 change 事件
  const names = events.map((e) => e.filename)
  const hasSub = names.some((n) => typeof n === 'string' && n.replace(/\\/g, '/').includes('sub/a.txt'))
  const hasChange = events.some((e) => e.eventType === 'change')
  console.log(hasSub && hasChange ? 'SEMANTICS-OK' : 'SEMANTICS-FAIL')
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(hasSub && hasChange ? 0 : 1)
}
void run()
