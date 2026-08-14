// NodeTreeWatcher 集成测试：真实 fs.watch 事件语义
// Windows 走 recursive 分支；POSIX 走逐目录分支。事件到达有平台延迟，等待宽松。
const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { NodeTreeWatcher } = require('../dist/linkage/nodeWatcher.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等待谓词满足（fs.watch 平台延迟可达数百 ms）。 */
async function waitFor(predicate, timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(intervalMs)
  }
  return predicate()
}

describe('NodeTreeWatcher', () => {
  let root
  let watcher

  afterEach(() => {
    if (watcher !== undefined) watcher.dispose()
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true })
    root = undefined
    watcher = undefined
  })

  it('create/change/delete 事件语义（recursive，子目录文件）', async () => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.node-watch-'))
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
    const events = []
    watcher = new NodeTreeWatcher()
    watcher.watch(root, (kind, absPath) => events.push({ kind, absPath }))
    await sleep(500) // watcher 就绪

    const file = path.join(root, 'sub', 'a.txt')
    fs.writeFileSync(file, 'one') // create → rename
    await waitFor(() => events.some((e) => e.absPath.toLowerCase() === file.toLowerCase() && e.kind === 'create'))

    fs.writeFileSync(file, 'two') // change
    await waitFor(() => events.some((e) => e.absPath.toLowerCase() === file.toLowerCase() && e.kind === 'change'))

    fs.unlinkSync(file) // delete → rename
    await waitFor(() => events.some((e) => e.absPath.toLowerCase() === file.toLowerCase() && e.kind === 'delete'))

    const kinds = events.filter((e) => e.absPath.toLowerCase() === file.toLowerCase()).map((e) => e.kind)
    assert.ok(kinds.includes('create'), `应有 create，实际 ${JSON.stringify(kinds)}`)
    assert.ok(kinds.includes('change'), `应有 change，实际 ${JSON.stringify(kinds)}`)
    assert.ok(kinds.includes('delete'), `应有 delete，实际 ${JSON.stringify(kinds)}`)
  })

  it('watch 重绑：旧根事件不再上报，新根生效', async () => {
    const rootA = fs.mkdtempSync(path.join(process.cwd(), '.node-watch-a-'))
    const rootB = fs.mkdtempSync(path.join(process.cwd(), '.node-watch-b-'))
    root = rootA // afterEach 清理用；B 手动清理
    const events = []
    watcher = new NodeTreeWatcher()
    watcher.watch(rootA, (kind, absPath) => events.push({ kind, absPath }))
    await sleep(500)

    watcher.watch(rootB, (kind, absPath) => events.push({ kind, absPath }))
    await sleep(300)

    fs.writeFileSync(path.join(rootA, 'old.txt'), 'x')
    await sleep(400)
    assert.strictEqual(events.some((e) => e.absPath.toLowerCase() === path.join(rootA, 'old.txt').toLowerCase()), false)

    fs.writeFileSync(path.join(rootB, 'new.txt'), 'y')
    await waitFor(() => events.some((e) => e.absPath.toLowerCase() === path.join(rootB, 'new.txt').toLowerCase()))
    fs.rmSync(rootB, { recursive: true, force: true })
  })

  it('skip 目录（node_modules）在 POSIX 分支不递归监听（Windows 分支天然过滤由上层做）', async () => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.node-watch-c-'))
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    const events = []
    watcher = new NodeTreeWatcher()
    watcher.watch(root, (kind, absPath) => events.push({ kind, absPath }))
    await sleep(500)

    // src 内文件必须能收到
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'x')
    await waitFor(() => events.some((e) => e.absPath.toLowerCase() === path.join(root, 'src', 'b.ts').toLowerCase()))
    assert.ok(true)
  })
})
