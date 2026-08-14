// relay 脚本路由测试（node:test + jsdom）：消息来源校验、hello URL 白名单、转发与拒绝
const { describe, it, after } = require('node:test')
const assert = require('node:assert')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { JSDOM } = require('jsdom')

const doms = []
after(() => {
  // 关闭 jsdom 窗口：取消 attachFrame 的加载超时定时器，避免测试进程被拖住 8s
  for (const dom of doms) dom.window.close()
})

function loadRelay() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <iframe id="dsh-frame"></iframe>
      <div id="status"><div id="status-text">boot</div><div id="status-err" style="display:none"></div></div>
    </body></html>`,
    { url: 'http://127.0.0.1:1234/', runScripts: 'outside-only', pretendToBeVisual: true }
  )
  doms.push(dom)
  const { window } = dom
  const posted = []
  window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) })
  const source = readFileSync(join(__dirname, '..', 'dist', 'webview', 'relay.js'), 'utf8')
  window.eval(source)
  const frame = window.document.getElementById('dsh-frame')
  // 记录 src 设置次数
  const srcSets = []
  Object.defineProperty(frame, 'src', {
    get() {
      return this.getAttribute('src')
    },
    set(value) {
      srcSets.push(value)
      this.setAttribute('src', value)
    },
  })
  /** 构造带指定 source/origin 的消息事件。 */
  const post = (sourceWin, origin, data) => {
    const event = new window.MessageEvent('message', { data, origin })
    Object.defineProperty(event, 'source', { value: sourceWin, configurable: true })
    window.dispatchEvent(event)
    return event
  }
  return { window, posted, frame, srcSets, post }
}

describe('relay 脚本', () => {
  it('加载即发 ready 握手', () => {
    const { posted } = loadRelay()
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posted[0])), { type: 'ready' })
  })

  it('宿主 hello（合法回环 url）→ 挂载 iframe + dshEmbed=1', () => {
    const { frame, srcSets, post, window } = loadRelay()
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    // jsdom 会规范化 URL（丢弃 ? 前斜杠）
    assert.strictEqual(frame.getAttribute('src'), 'http://127.0.0.1:3080?dshEmbed=1')
    assert.strictEqual(srcSets.length, 1)
  })

  it('hello 重复到达不重复设置 src（幂等，防整页重载）', () => {
    const { srcSets, post, window } = loadRelay()
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    assert.strictEqual(srcSets.length, 1)
  })

  it('hello URL 白名单：非回环/带路径/非 http 一律拒绝', () => {
    const { frame, srcSets, post, window } = loadRelay()
    for (const url of [
      'http://evil.com:3080',
      'https://evil.com:3080',
      'http://127.0.0.1:3080/some/path',
      'http://192.168.1.5:3080',
      'javascript:alert(1)',
    ]) {
      post(window, 'null', { type: 'hello', url })
    }
    assert.strictEqual(srcSets.length, 0)
    assert.strictEqual(frame.getAttribute('src'), null)
  })

  it('iframe 伪造 hello（source=本 iframe 窗口）被拒绝（防嵌入页重定向面板）', () => {
    const { frame, srcSets, post } = loadRelay()
    post(frame.contentWindow, 'http://127.0.0.1:3080', { type: 'hello', url: 'http://127.0.0.1:3999' })
    assert.strictEqual(srcSets.length, 0)
    assert.strictEqual(frame.getAttribute('src'), null)
  })

  it('宿主消息 source 非 window（真实 webview 为外层桥接窗口/null）也生效', () => {
    const { frame, srcSets, post } = loadRelay()
    // 模拟真实 VSCode webview：宿主消息 source 为 null
    post(null, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    assert.strictEqual(frame.getAttribute('src'), 'http://127.0.0.1:3080?dshEmbed=1')
    assert.strictEqual(srcSets.length, 1)
  })

  it('iframe 上行 openFile：正确 source+origin → 转发扩展', () => {
    const { frame, posted, post } = loadRelay()
    post(frame.contentWindow, 'http://127.0.0.1:3080', { source: 'dsh-vscode', type: 'openFile', path: 'src/a.ts', line: 2, column: 3 })
    const forwarded = posted.find((m) => m.type === 'openFile')
    assert.ok(forwarded !== undefined)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(forwarded)), { type: 'openFile', path: 'src/a.ts', line: 2, column: 3 })
  })

  it('iframe 上行 origin 非回环 → 拒绝转发', () => {
    const { frame, posted, post } = loadRelay()
    post(frame.contentWindow, 'http://evil.com:3080', { source: 'dsh-vscode', type: 'openFile', path: 'src/a.ts' })
    assert.strictEqual(posted.find((m) => m.type === 'openFile'), undefined)
  })

  it('iframe 上行 line/column 类型不合法 → 拒绝转发', () => {
    const { frame, posted, post } = loadRelay()
    post(frame.contentWindow, 'http://127.0.0.1:3080', { source: 'dsh-vscode', type: 'openFile', path: 'src/a.ts', line: 'x' })
    assert.strictEqual(posted.find((m) => m.type === 'openFile'), undefined)
  })

  it('iframe 上行 sessionCurrent → 转发扩展', () => {
    const { frame, posted, post } = loadRelay()
    post(frame.contentWindow, 'http://127.0.0.1:3080', { source: 'dsh-vscode', type: 'sessionCurrent', sessionId: 's-9' })
    const forwarded = posted.find((m) => m.type === 'sessionCurrent')
    assert.ok(forwarded !== undefined)
    assert.strictEqual(forwarded.sessionId, 's-9')
  })

  it('hostStatus 状态渲染：connecting/error', () => {
    const { window, post } = loadRelay()
    const text = window.document.getElementById('status-text')
    const err = window.document.getElementById('status-err')
    post(window, 'null', { type: 'hostStatus', status: 'connecting' })
    assert.ok(text.textContent.includes('启动'))
    post(window, 'null', { type: 'hostStatus', status: 'error', message: 'boom' })
    assert.ok(text.textContent.includes('失败'))
    assert.ok(err.textContent.includes('boom'))
    assert.strictEqual(err.style.display, 'block')
  })

  it('iframe 挂载后 connecting 不再盖状态层（防覆盖层滞留）', () => {
    const { window, frame, srcSets, post } = loadRelay()
    const statusEl = window.document.getElementById('status')
    // 初始 connecting：显示覆盖层
    post(window, 'null', { type: 'hostStatus', status: 'connecting' })
    assert.strictEqual(statusEl.style.display, 'flex')
    // hello 挂载 iframe
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    assert.strictEqual(srcSets.length, 1)
    // 模拟 iframe load → 隐藏状态层、显示 iframe
    frame.dispatchEvent(new window.Event('load'))
    assert.strictEqual(statusEl.style.display, 'none')
    assert.strictEqual(frame.style.display, 'block')
    // 重启/stop 时的滞留 connecting 不得重新盖住 iframe
    post(window, 'null', { type: 'hostStatus', status: 'connecting' })
    assert.strictEqual(statusEl.style.display, 'none')
    // 同 URL hello 幂等（不重设 src）且不恢复覆盖层
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    assert.strictEqual(srcSets.length, 1)
    assert.strictEqual(statusEl.style.display, 'none')
    // 错误仍然要盖住并展示
    post(window, 'null', { type: 'hostStatus', status: 'error', message: 'boom' })
    assert.strictEqual(statusEl.style.display, 'flex')
  })
})
