/**
 * host 管理的小工具：dsh 命令解析、空闲端口、HTTP 就绪探测、cmd 引号转义。
 * 全部纯函数，便于 vitest 测试。
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { delimiter, dirname, join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'

export interface DshCommand {
  /** 可执行程序。 */
  file: string
  /** 前缀参数（如 ['node', '<bin.js>'] 时 file 为 node）。 */
  prefix: string[]
  /** 是否需要 shell（Windows .cmd/.bat shim）。 */
  useShell: boolean
}

/**
 * 解析系统 node 可执行文件。
 * 注意：扩展宿主内 process.execPath 是 VSCode 的 Electron 二进制，绝不是 node.exe！
 * 顺序：PATH 中的 node.exe/node → 常见安装目录 → 报错。
 */
export function resolveNodeExecutable(): string {
  const names = process.platform === 'win32' ? ['node.exe'] : ['node']
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue
    for (const name of names) {
      const full = join(dir, name)
      if (existsSync(full)) return full
    }
  }
  // 常见安装目录兜底
  const fallbacks = process.platform === 'win32' ? [join('C:', 'Program Files', 'nodejs', 'node.exe')] : ['/usr/local/bin/node', '/usr/bin/node']
  for (const full of fallbacks) {
    if (existsSync(full)) return full
  }
  throw new Error('未找到 node 可执行文件：请安装 Node.js（>=20）并加入 PATH')
}

/** 把用户配置的 executablePath 解析为可执行程序 + 前缀参数。 */
export function resolveConfiguredCommand(configured: string): DshCommand {
  const trimmed = configured.trim()
  if (trimmed === '') throw new Error('dshVscode.executablePath 为空')
  if (/\.(?:c?js|mjs)$/i.test(trimmed)) {
    // bin.js 形态：用系统 node 直接执行
    return { file: resolveNodeExecutable(), prefix: [trimmed], useShell: false }
  }
  return { file: trimmed, prefix: [], useShell: /\.(cmd|bat|ps1)$/i.test(trimmed) || process.platform === 'win32' }
}

/** 候选的 @deepseek-ai/dsh 安装位置（返回 lib/bin.js 路径，存在才保留）。 */
export function candidateBinJs(): string[] {
  const candidates: string[] = []
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const appData = process.env.APPDATA ?? ''
  // 1) npx 缓存：%LOCALAPPDATA%\npm-cache\_npx\*\node_modules\@deepseek-ai\dsh\lib\bin.js
  if (localAppData !== '') {
    try {
      const npxRoot = join(localAppData, 'npm-cache', '_npx')
      if (existsSync(npxRoot)) {
        const hashes = readdirSync(npxRoot)
          .filter((name) => name !== 'logs')
          .map((name) => ({ name, mtime: statSync(join(npxRoot, name)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
        for (const entry of hashes) {
          candidates.push(join(npxRoot, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
        }
      }
    } catch {
      /* ignore */
    }
  }
  // 2) 全局 npm：%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  if (appData !== '') {
    candidates.push(join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  // 3) node 安装目录内的全局包（少见但合法）
  try {
    candidates.push(join(dirname(resolveNodeExecutable()), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  } catch {
    /* node 未安装时忽略 */
  }
  return candidates.filter((candidate) => existsSync(candidate))
}

/**
 * 解析 dsh 命令：
 *  1. 配置的 executablePath（优先）
 *  2. 候选安装位置的 lib/bin.js 用 node 直接执行（最可靠，绕开 cmd shim/PATH）
 *  3. PATH 中的 dsh.cmd/dsh.exe/dsh.bat/dsh（真实文件）
 *  4. 裸命令（shell 解析），但必须通过 `dsh --version` 探测（退出码 0）
 */
export function resolveDshCommand(configuredPath: string | undefined): DshCommand {
  if (configuredPath !== undefined && configuredPath.trim() !== '') return resolveConfiguredCommand(configuredPath)

  // 2) bin.js 候选（node 直跑）
  const binJs = candidateBinJs()[0]
  if (binJs !== undefined) {
    return { file: resolveNodeExecutable(), prefix: [binJs], useShell: false }
  }

  // 3) PATH 中的真实 shim/exe
  const pathEnv = process.env.PATH ?? ''
  const shims = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.bat'] : ['dsh']
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue
    for (const candidate of shims) {
      const full = join(dir, candidate)
      if (existsSync(full)) {
        return { file: full, prefix: [], useShell: process.platform === 'win32' && candidate !== 'dsh.exe' }
      }
    }
  }

  // 4) 裸命令 + 严格探测（shell 找不到命令时退出码非 0 —— 防 'dsh.cmd' 不是命令 的假阳性）
  const bare = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const probe = spawnSync(bare, ['--version'], {
    shell: process.platform === 'win32',
    timeout: 10_000,
    stdio: 'ignore',
  })
  if (probe.error === undefined && probe.status === 0) {
    return { file: bare, prefix: [], useShell: process.platform === 'win32' }
  }

  throw new Error(
    '未找到 dsh：请 `npm i -g @deepseek-ai/dsh`（或 npx 安装后重启 VSCode），或在设置 dshVscode.executablePath 中直接指向 @deepseek-ai/dsh/lib/bin.js'
  )
}

/** cmd 引号转义（处理空格/特殊字符；参数含双引号视为非法）。 */
export function quoteCmdArg(arg: string): string {
  if (arg.includes('"')) throw new Error(`参数含非法双引号：${arg}`)
  return /[\s&|<>^]/.test(arg) ? `"${arg}"` : arg
}

/** 探测端口是否空闲（尝试 bind）。 */
export function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, host, () => {
      server.close(() => resolve(true))
    })
  })
}

/** 选一个空闲端口：优先 preferred，被占用则 OS 分配。 */
export async function pickFreePort(preferred?: number): Promise<number> {
  if (preferred !== undefined && (await portFree(preferred))) return preferred
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : undefined
      server.close(() => {
        if (port === undefined) reject(new Error('无法分配端口'))
        else resolve(port)
      })
    })
  })
}

/** 默认共享端口（浏览器 GUI 常用端口，保持同一实例体验）。 */
export const DEFAULT_SHARE_PORT = 3080

/**
 * 桥接 health 探测（严格形态校验）：
 * 无 bridge 的 DSH 实例对未知路径回退 index.html（200）——仅凭状态码会假阳性，
 * 必须校验 content-type=application/json 且 body 含 `"bridge"`。
 * @returns true 当且仅当该地址上存在 dsh-vscode-bridge。
 */
export async function probeBridgeHealth(url: string, token = '', timeoutMs = 2000): Promise<boolean> {
  return (await fetchBridgeHealth(url, token, timeoutMs)).ok
}

/**
 * 桥接 health 详情：与 {@link probeBridgeHealth} 相同的严格校验，额外解析出实例
 * 自身 PID（bridge 的 health 路由返回 `pid: process.pid`）。connect 模式靠它拿到
 * 所连接实例的 PID，供退出时按设置（stopConnectedInstanceOnExit）结束实例。
 */
export async function fetchBridgeHealth(
  url: string,
  token = '',
  timeoutMs = 2000
): Promise<{ ok: boolean; pid?: number }> {
  const query = token !== '' ? `?token=${encodeURIComponent(token)}` : ''
  try {
    const response = await fetch(`${url}/dsh-vscode/health${query}`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status !== 200) return { ok: false }
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) return { ok: false }
    const body = await response.text()
    if (!body.includes('"ok"') || !body.includes('"bridge"')) return { ok: false }
    let pid: number | undefined
    try {
      const parsed = JSON.parse(body) as { pid?: unknown }
      if (typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid)) pid = parsed.pid
    } catch {
      /* ignore */
    }
    return { ok: true, pid }
  } catch {
    return { ok: false }
  }
}

/** DSH 实例探测：root 200 且页面含 DSH 前端特征（title/__DSH_BOOT__）。 */
export async function probeDshInstance(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const response = await fetch(`${url}/`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
    if (response.status !== 200) return false
    const body = await response.text()
    return body.includes('DeepSeek Harness') || body.includes('__DSH_BOOT__')
  } catch {
    return false
  }
}

/** 轮询直到 predicate 满足或超时；返回是否满足。 */
export async function waitUntil(
  predicate: () => Promise<boolean>,
  intervalMs = 500,
  timeoutMs = 30_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** 从 baseUrl 提取端口。 */
export function portOf(baseUrl: string): number {
  const url = new URL(baseUrl)
  return url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
}
