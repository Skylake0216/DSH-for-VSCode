/**
 * dsh-vscode-bridge — DSH for VSCode 桥接插件（host 半区，零运行时依赖）。
 *
 * 职责：
 *  1. /dsh-vscode/health    — 就绪探测（可选 token 门控），供扩展轮询。
 *  2. /dsh-vscode/bridge.js — 提供给页面内注入的桥接脚本（可选 token 门控）。
 *  3. tapIndex              — 向每个 index.html 响应注入
 *                             `<script defer src="/dsh-vscode/bridge.js">`，
 *                             覆盖 SPA fallback 路由（index tap 对每个 index 生效）。
 *  4. systemPrompt.section  — 向 agent 公告本桥接的存在与协作方式。
 *
 * 通过 `dsh web --patch <overlay>` 加载；overlay 中 name 用 file: URL 指向本文件，
 * 因此**不修改用户 profile 的任何文件**。config.token 可选：设置后 health 与
 * bridge.js 路由要求 ?token= 匹配（防端口抢占/伪造）。
 *
 * @module dsh-vscode-bridge
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** 稳定插件名。 */
export const name = 'dsh-vscode-bridge'

/** 需要的宿主服务：路由注册表 + systemPrompt 公告带。 */
export const inject = ['webServer', 'systemPrompt']

/** 本模块所在目录（bridge.js 同目录）。 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/** bridge.js 页面脚本，启动时读一次（内容恒定）。 */
const BRIDGE_JS_SOURCE = readFileSync(join(PLUGIN_DIR, 'bridge.js'), 'utf8')

/** 注入脚本的标记属性（幂等检查用）。 */
const INJECT_MARKER = 'data-dsh-vscode-bridge'

/** 公告段在工具引导带中的顺序（aionui-panel 用 210，本桥接 220）。 */
const SECTION_ORDER = 220

/** model-facing 公告：插件存在、能力与边界。 */
const BRIDGE_GUIDANCE = '本机已安装 dsh-vscode-bridge 桥接插件（DSH for VSCode）：当本 Web GUI 嵌入 VSCode 时（地址带 ?dshEmbed=1），用户点击交付文件路径会在 VSCode 原生编辑器中打开文件，agent 写入的文件也会同步出现在 VSCode 编辑器；用户编辑保存在磁盘后你读到的就是最新内容（磁盘是唯一事实源）。用户提到「在 VSCode 中打开」「用编辑器打开」时即指此能力。若 GUI 运行在普通浏览器（无 dshEmbed），该能力不生效。'

/**
 * 挂载桥接插件。
 * @param ctx - 携带 webServer / systemPrompt 服务的 context。
 * @param config - { token?: string }；token 设置后 health 与 bridge.js 路由需带匹配的 ?token=。
 */
export function apply(ctx, config) {
  const token = typeof config?.token === 'string' && config.token !== '' ? config.token : ''
  const tokenQuery = token !== '' ? `?token=${encodeURIComponent(token)}` : ''

  /** 校验请求 token；未配置 token 时放行（开发便利）。 */
  const authorized = (req) => {
    if (token === '') return true
    const url = new URL(req.url ?? '/', 'http://x')
    return url.searchParams.get('token') === token
  }

  const disposers = [
    // 1) health —— 扩展的就绪探测 + 身份确认。
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-vscode/health',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        if (!authorized(req)) {
          res.writeHead(401)
          res.end('unauthorized')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, bridge: 'dsh-vscode-bridge', pid: process.pid }))
      },
    }),

    // 2) bridge.js 页面脚本。
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-vscode/bridge.js',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        if (!authorized(req)) {
          res.writeHead(401)
          res.end('unauthorized')
          return
        }
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(BRIDGE_JS_SOURCE)
      },
    }),

    // 3) tapIndex —— 向每个 index.html 注入桥接脚本（幂等）。
    ctx.webServer.tapIndex((html) => {
      if (html.includes(INJECT_MARKER)) return html
      const script = `<script defer ${INJECT_MARKER} src="/dsh-vscode/bridge.js${tokenQuery}"></script>`
      const headEnd = html.indexOf('</head>')
      if (headEnd !== -1) return `${html.slice(0, headEnd)}${script}${html.slice(headEnd)}`
      return `${html}${script}`
    }),

    // 4) agent 公告。
    ctx.systemPrompt.section({
      name: 'plugin:dsh-vscode-bridge',
      order: SECTION_ORDER,
      text: BRIDGE_GUIDANCE,
    }),
  ]

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'dsh-vscode-bridge: routes + tap + prompt')
}
