/**
 * DSH host 生命周期管理：
 *  - 模式解析（spawn / connect / auto）
 *  - spawn：空闲端口（sharePort 优先 3080）、globalStorage 中生成 --patch 叠加层
 *    （file: URL 加载扩展自带 bridge 插件，零 profile 突变）、spawn `dsh web`、
 *    health 轮询就绪、globalState 记录 {pid,port,token} 支持重载后 reattach
 *  - connect：直连已有实例（共享实例，bridge 能力视实例而定）
 *  - 清理：SIGTERM 优雅退出 + 超时强杀（Windows taskkill /T /F）
 */
import * as vscode from 'vscode'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, openSync, closeSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listSessions } from './dshApi'
import {
  DEFAULT_SHARE_PORT,
  fetchBridgeHealth,
  pickFreePort,
  portOf,
  probeBridgeHealth,
  probeDshInstance,
  quoteCmdArg,
  resolveDshCommand,
  waitUntil,
} from './hostUtils'

export interface HostRuntime {
  mode: 'spawn' | 'connect'
  /** http://127.0.0.1:<port> */
  url: string
  port: number
  /** spawn 模式生成的健康检查 token（connect 模式为空）。 */
  token: string
  /** spawn 模式为子进程 PID；connect 模式带桥接时为实例自身 PID（供退出时结束实例）。 */
  pid?: number
  /** 实例是否带 dsh-vscode-bridge（点击打开等能力可用）。 */
  hasBridge: boolean
}

export type HostStatus = 'starting' | 'ready' | 'error'

export interface HostState {
  status: HostStatus
  runtime?: HostRuntime
  message?: string
}

export interface HostManagerOptions {
  extensionPath: string
  /** 叠加层与日志目录（globalStorage）。 */
  storageDir: string
  /** 读配置。 */
  getSetting<T>(key: string, fallback: T): T
  /** globalState 存取（跨窗口共享的宿主记录）。 */
  getState<T>(key: string): T | undefined
  setState(key: string, value: unknown): Thenable<void>
  /** 工作区文件夹（可能 undefined）。 */
  workspaceFolder(): vscode.WorkspaceFolder | undefined
  /** 状态变化回调（HostManager 主动调用）。 */
  onStateChange(state: HostState): void
  log(message: string): void
}

/** globalState 中的宿主记录（跨窗口 / 重载 reattach）。 */
export interface HostRecord {
  version: 1
  port: number
  token: string
  url: string
  pid?: number
  startedAt: number
}

const RECORD_KEY = 'dshVscode.hostRecord'

export class HostManager implements vscode.Disposable {
  private child: ChildProcess | undefined
  private runtime: HostRuntime | undefined
  private status: HostStatus = 'starting'
  private disposed = false
  private killTimer: ReturnType<typeof setTimeout> | undefined
  /** 主动 stop 中：退出事件不报"异常退出"。 */
  private deliberateStop = false
  /** in-flight 的 start（防并发双 spawn）。 */
  private starting: Promise<HostRuntime> | undefined

  constructor(private readonly options: HostManagerOptions) {}

  get state(): HostState {
    return this.runtime === undefined
      ? { status: this.status }
      : { status: this.status, runtime: this.runtime }
  }

  /** 当前 runtime（未就绪时 undefined）。 */
  get current(): HostRuntime | undefined {
    return this.runtime
  }

  private emit(): void {
    this.options.onStateChange(this.state)
  }

  private setStatus(status: HostStatus, message?: string): void {
    this.status = status
    this.options.log(`state → ${status}${message !== undefined ? `：${message}` : ''}`)
    this.emit()
  }

  /** 连接模式：探测 connectUrl 是否已有 DSH 实例（桥接存在性严格校验）。 */
  private async probeConnect(url: string): Promise<HostRuntime | undefined> {
    // webview CSP 与 DSH 信任栅栏都只支持回环：非回环地址给明确错误而非"空白面板"。
    let hostname: string
    try {
      hostname = new URL(url).hostname
    } catch {
      throw new Error(`connectUrl 无效：${url}`)
    }
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]' && hostname !== '::1') {
      throw new Error(`connectUrl 仅支持本机回环地址（127.0.0.1/localhost），当前：${url}`)
    }
    const dshOk = await probeDshInstance(url)
    this.options.log(`probeConnect(${url}): probeDshInstance=${dshOk}`)
    if (!dshOk) return undefined
    const health = await fetchBridgeHealth(url)
    this.options.log(`probeConnect(${url}): bridge=${JSON.stringify(health)}`)
    return {
      mode: 'connect',
      url,
      port: portOf(url),
      token: '',
      hasBridge: health.ok,
      // 带桥接的实例经 health 暴露自身 PID：退出时按 stopConnectedInstanceOnExit 可结束它
      pid: health.pid,
    }
  }

  /** YAML 单引号标量转义（'' 转义单引号，防路径含引号时截断/注入）。 */
  private static yamlScalar(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
  }

  /** 生成 --patch 叠加层（globalStorage 内），引用扩展自带的 bridge 插件。 */
  private writeOverlay(token: string): string {
    const overlayDir = join(this.options.storageDir, 'overlay')
    mkdirSync(overlayDir, { recursive: true })
    const bridgeFile = pathToFileURL(join(this.options.extensionPath, 'bridge', 'lib', 'index.js')).href
    const overlay = [
      `# 由 DSH for VSCode 生成 —— 经 \`dsh web --patch <此文件>\` 在启动时叠加，`,
      `# 不改动用户 profile 的任何文件。bridge 插件以 file: URL 加载扩展自带副本。`,
      `- insert:`,
      `    - id: dsh-vscode-bridge`,
      `      name: ${HostManager.yamlScalar(bridgeFile)}`,
      `      config:`,
      `        token: ${HostManager.yamlScalar(token)}`,
      ``,
    ].join('\n')
    const overlayPath = join(overlayDir, 'overlay.yml')
    writeFileSync(overlayPath, overlay, 'utf8')
    return overlayPath
  }

  /** 打开日志文件描述符（始终落盘——诊断必需；按时间轮转保留最近 5 份）。 */
  private openLogFd(): { stdoutFd?: number; logPath?: string } {
    const logDir = join(this.options.storageDir, 'logs')
    mkdirSync(logDir, { recursive: true })
    // 轮转：只保留最近的 5 份 host-*.log
    try {
      const logs = readdirSync(logDir)
        .filter((name) => name.startsWith('host-') && name.endsWith('.log'))
        .map((name) => ({ name, mtime: statSync(join(logDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      for (const old of logs.slice(5)) {
        try {
          unlinkSync(join(logDir, old.name))
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    const logPath = join(logDir, `host-${Date.now()}.log`)
    try {
      const fd = openSync(logPath, 'a')
      return { stdoutFd: fd, logPath }
    } catch {
      return {}
    }
  }

  /** 探测是否存在"并发写入风险"的已有 DSH 实例：connectUrl / 共享端口 / 本扩展上次 spawn 的记录。 */
  private async findLiveDshInstance(): Promise<{ url: string } | undefined> {
    const urls = new Set<string>()
    const connectUrl = this.options.getSetting<string>('dshVscode.connectUrl', 'http://127.0.0.1:3080')
    urls.add(connectUrl)
    if (this.options.getSetting('dshVscode.sharePort', true)) urls.add(`http://127.0.0.1:${DEFAULT_SHARE_PORT}`)
    for (const url of urls) {
      if (await probeDshInstance(url, 1500)) return { url }
    }
    const record = this.options.getState<HostRecord>(RECORD_KEY)
    if (record !== undefined && record.version === 1) {
      if (await probeBridgeHealth(record.url, record.token, 1500)) return { url: record.url }
    }
    return undefined
  }

  /**
   * 双实例守卫：两个 DSH host 共享同一 ~/.dsh 并发写同一个会话日志时，
   * 会各自算出相同的下一个 seq 并都追加，造成 committed region 重复 seq
   * （corrupt session log: seq gap in committed region）——日志永久损坏且只能手工修复。
   * 默认拒绝在已有 DSH 实例运行时再 spawn 一个；dshVscode.allowDualInstance 显式放行（自担风险）。
   */
  private async assertNoDualInstance(): Promise<void> {
    if (this.options.getSetting('dshVscode.allowDualInstance', false)) return
    const conflict = await this.findLiveDshInstance()
    if (conflict === undefined) return
    throw new Error(
      `检测到 ${conflict.url} 上已有 DSH 实例在运行。两个实例共享同一 ~/.dsh 并发写会话日志会损坏日志（corrupt session log: seq gap）。` +
      `请先停止已有实例；若该实例带 vscode 桥接，可把 dshVscode.hostMode 改为 auto/connect 连接它；` +
      `确实需要双实例时可在设置中开启 dshVscode.allowDualInstance（自担风险）。`
    )
  }

  /** spawn 一个 dsh web 实例。 */
  private async spawnHost(): Promise<HostRuntime> {
    await this.assertNoDualInstance()
    const profile = this.options.getSetting('dshVscode.profileName', 'web')
    const sharePort = this.options.getSetting('dshVscode.sharePort', true)
    const preferred = sharePort ? DEFAULT_SHARE_PORT : undefined
    const port = await pickFreePort(preferred)
    const token = randomBytes(24).toString('hex')
    const overlayPath = this.writeOverlay(token)

    const command = resolveDshCommand(this.options.getSetting('dshVscode.executablePath', ''))

    const args = command.prefix.slice()
    if (profile === 'web') args.push('web')
    else args.push('--profile', profile)
    args.push('--patch', overlayPath, '--port', String(port))

    const cwd = this.resolveCwd()
    const { stdoutFd, logPath } = this.openLogFd()

    const spawnArgs = command.useShell ? args.map(quoteCmdArg) : args
    this.options.log(`spawn: ${command.file} ${spawnArgs.join(' ')} (cwd=${cwd})`)

    // 净化子进程环境：VSCode 扩展宿主注入的 NODE_OPTIONS / ELECTRON_RUN_AS_NODE
    // 会让继承它们的普通 node 子进程（dsh）加载失败或行为异常——必须剔除。
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    delete env.ELECTRON_RUN_AS_NODE

    const child = spawn(command.file, spawnArgs, {
      cwd,
      shell: command.useShell,
      stdio: ['ignore', stdoutFd ?? 'ignore', stdoutFd ?? 'ignore'],
      env,
      windowsHide: true,
    })
    this.child = child
    this.deliberateStop = false
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
    /** 关闭日志 fd（error/exit 两条路径共用，防 ENOENT 时泄漏）。 */
    const closeLog = (): void => {
      if (stdoutFd === undefined) return
      try {
        closeSync(stdoutFd)
      } catch {
        /* ignore */
      }
    }
    child.once('error', (error) => {
      exited = { code: null, signal: null }
      closeLog()
      if (this.child !== child || this.disposed || this.deliberateStop) return
      this.options.log(`spawn error: ${String(error)}`)
      this.setStatus('error', `启动 dsh 失败：${String(error)}${logPath !== undefined ? `（日志：${logPath}）` : ''}`)
    })
    child.once('exit', (code, signal) => {
      exited = { code, signal }
      closeLog()
      this.options.log(
        `child exit: code=${String(code)} signal=${String(signal)} deliberateStop=${String(this.deliberateStop)} disposed=${String(this.disposed)} isCurrent=${String(this.child === child)}`
      )
      // 旧子进程（已被 stop/spawn 替换）的退出事件不得影响当前状态
      if (this.child !== child || this.disposed || this.deliberateStop) return
      this.setStatus('error', `dsh 进程异常退出（code=${String(code)} signal=${String(signal)}），日志：${logPath ?? '（无）'}`)
    })

    const url = `http://127.0.0.1:${port}`
    let ready = false
    try {
      ready = await waitUntil(
        async () => {
          // 主动 stop：立即中止等待（进程已被 kill）。
          if (this.deliberateStop) {
            throw new Error('DSH host 启动已被取消')
          }
          // 子进程提前退出：立即失败并带上退出码与日志路径（比干等超时好诊断）。
          if (exited !== undefined) {
            throw new Error(
              `dsh 进程提前退出（code=${String(exited.code)} signal=${String(exited.signal)}），日志：${logPath ?? '（无）'}。启动命令：${command.file} ${spawnArgs.join(' ')}`
            )
          }
          return probeBridgeHealth(url, token, 2000)
        },
        500,
        this.options.getSetting('dshVscode.readyTimeoutSec', 60) * 1000
      )
    } catch (error) {
      // 启动被取消/进程退出：确保 child 与 fd 已清理，不留孤儿
      this.cleanupChild(child)
      throw error
    }
    if (!ready) {
      // 超时：kill 慢启动/挂起的 child 并清理（不留孤儿进程与 fd）
      this.cleanupChild(child)
      const hint = exited === undefined ? '' : `（进程已退出，见日志 ${logPath ?? ''}）`
      throw new Error(
        `DSH host 未在超时内就绪（${url}）${hint}。请检查 dsh 是否可用（设置 dshVscode.executablePath），日志：${logPath ?? '（无）'}`
      )
    }
    const runtime: HostRuntime = { mode: 'spawn', url, port, token, pid: child.pid, hasBridge: true }
    this.runtime = runtime
    this.setStatus('ready')
    await this.persistRecord(runtime)
    return runtime
  }

  /** host 工作目录：设置 > 工作区文件夹 > 用户主目录。 */
  private resolveCwd(): string {
    const configured = this.options.getSetting('dshVscode.hostCwd', '')
    if (configured.trim() !== '') return configured.trim()
    const folder = this.options.workspaceFolder()
    if (folder !== undefined) return folder.uri.fsPath
    return homedir()
  }

  /** 持久化宿主记录（跨窗口/重载 reattach 用）。 */
  private async persistRecord(runtime: HostRuntime): Promise<void> {
    const record: HostRecord = {
      version: 1,
      port: runtime.port,
      token: runtime.token,
      url: runtime.url,
      pid: runtime.pid,
      startedAt: Date.now(),
    }
    await this.options.setState(RECORD_KEY, record)
  }

  /** 尝试 reattach 旧记录（globalState 中的 spawn 记录仍存活时）。 */
  private async reattachRecord(): Promise<HostRuntime | undefined> {
    const record = this.options.getState<HostRecord>(RECORD_KEY)
    if (record === undefined || record.version !== 1) return undefined
    const alive = await probeBridgeHealth(record.url, record.token, 1500)
    if (!alive) {
      await this.options.setState(RECORD_KEY, undefined)
      return undefined
    }
    this.options.log(`reattach: ${record.url}`)
    const runtime: HostRuntime = { mode: 'spawn', url: record.url, port: record.port, token: record.token, pid: record.pid, hasBridge: true }
    this.runtime = runtime
    this.setStatus('ready')
    return runtime
  }

  /** 启动（或连接）DSH host。in-flight 的 start 复用同一 promise，防并发双 spawn。 */
  async start(): Promise<HostRuntime> {
    // 幂等保护必须最先判断：否则第二次 start() 会误杀正在启动中的 child。
    if (this.starting !== undefined) {
      this.options.log(`start(): 已有 in-flight 启动，复用`)
      return this.starting
    }
    // 崩溃/失败后遗留的 runtime 不是可用实例：重置后走正常启动流程（自动恢复）。
    if (this.runtime !== undefined && this.status !== 'error') {
      this.options.log(`start(): 已就绪，直接返回 ${this.runtime.url}`)
      return this.runtime
    }
    if (this.status === 'error' || this.runtime === undefined) {
      this.runtime = undefined
      if (this.child !== undefined && this.isChildRunning(this.child)) this.cleanupChild(this.child)
    }
    this.starting = this.doStart()
    try {
      return await this.starting
    } finally {
      this.starting = undefined
    }
  }

  private async doStart(): Promise<HostRuntime> {
    this.setStatus('starting')
    const mode = this.options.getSetting<'auto' | 'spawn' | 'connect'>('dshVscode.hostMode', 'auto')
    const connectUrl = this.options.getSetting<string>('dshVscode.connectUrl', 'http://127.0.0.1:3080')
    this.options.log(`doStart: mode=${mode} connectUrl=${connectUrl}`)

    try {
      if (mode === 'connect') {
        const existing = await this.probeConnect(connectUrl)
        if (existing === undefined) throw new Error(`connectUrl（${connectUrl}）上没有可用的 DSH 实例`)
        this.runtime = existing
        this.setStatus('ready')
        return existing
      }
      if (mode === 'spawn') {
        return await this.spawnHost()
      }
      // auto：先探测已有实例（共享），否则按 autoModeSpawn 决定是否由插件托管启动
      const existing = await this.probeConnect(connectUrl)
      if (existing !== undefined) {
        this.runtime = existing
        this.setStatus('ready')
        return existing
      }
      const reattached = await this.reattachRecord()
      if (reattached !== undefined) return reattached
      if (this.options.getSetting('dshVscode.autoModeSpawn', true)) {
        return await this.spawnHost()
      }
      throw new Error(
        `connectUrl（${connectUrl}）上没有可用的 DSH 实例（dshVscode.autoModeSpawn 已关闭，auto 模式不会自动托管启动：可重新开启该设置，或改用 spawn 模式）`
      )
    } catch (error) {
      this.setStatus('error', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  /** 判断 child 是否仍在运行（signal 退出时 exitCode 也是 null，必须同时看 signalCode）。 */
  private isChildRunning(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null
  }

  /** 清理一个已知 child（kill + 强杀兜底 + 摘除引用）。 */
  private cleanupChild(child: ChildProcess): void {
    if (this.child === child) this.child = undefined
    if (!this.isChildRunning(child)) return
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    const pid = child.pid
    setTimeout(() => {
      if (!this.isChildRunning(child)) return
      try {
        if (process.platform === 'win32' && pid !== undefined) {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        /* ignore */
      }
    }, 3000)
  }

  /**
   * 同步结束托管子进程：SIGTERM + 3s 后强杀兜底。
   * 不 await——VSCode 退出时宿主进程可能在 stop() 的 async setState 完成前就被终止，
   * 若 kill 排在 await 之后会留下孤儿 host 进程。
   */
  private killChildSync(): void {
    const child = this.child
    if (child === undefined) return
    this.child = undefined
    if (!this.isChildRunning(child)) return
    this.deliberateStop = true
    const pid = child.pid
    try {
      child.kill() // SIGTERM —— dsh 有优雅 shutdown 控制器
    } catch {
      /* ignore */
    }
    this.killTimer = setTimeout(() => {
      if (!this.isChildRunning(child)) return
      try {
        if (process.platform === 'win32' && pid !== undefined) {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        /* ignore */
      }
    }, 3000)
  }

  /** 停止 host：无论 runtime 是否已就绪，只要子进程活着就杀（防启动中 stop 漏杀）。 */
  async stop(): Promise<void> {
    this.runtime = undefined
    this.status = 'starting'
    this.emit()
    this.killChildSync()
    await this.options.setState(RECORD_KEY, undefined)
  }

  /**
   * VSCode 退出 / 扩展停用时调用：
   *  - `dshVscode.stopHostOnExit`（默认开）：结束由本扩展在本会话托管的 host 子进程
   *    （spawn 模式，或 auto 模式下由扩展启动的实例）。
   *  - `dshVscode.stopConnectedInstanceOnExit`（默认关）：结束 connect 模式下所连接的实例
   *    （仅带桥接、能拿到 PID 的实例）。
   * 关闭对应项时保留运行（不清记录、不杀进程，下次激活可接回）。
   */
  stopOnExit(): void {
    const stopHost = this.options.getSetting('dshVscode.stopHostOnExit', true)
    const stopConnected = this.options.getSetting('dshVscode.stopConnectedInstanceOnExit', false)
    if (!stopHost && !stopConnected) return
    if (stopHost) {
      this.killChildSync()
      void this.options.setState(RECORD_KEY, undefined)
    }
    if (stopConnected) this.killConnectedInstanceSync()
    this.runtime = undefined
    this.status = 'starting'
    this.emit()
  }

  /** 同步结束 connect 模式下连接的实例：按 health 拿到的 PID 强杀（仅带桥接的实例）。 */
  private killConnectedInstanceSync(): void {
    const runtime = this.runtime
    if (runtime?.mode !== 'connect' || !runtime.hasBridge || runtime.pid === undefined) return
    const pid = runtime.pid
    this.options.log(`stop connected instance on exit: pid ${pid} (${runtime.url})`)
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      } else {
        process.kill(pid, 'SIGTERM')
      }
    } catch {
      /* ignore */
    }
  }

  /** 列出会话（转发 dshApi，供 cwd 跟踪）。 */
  listSessions() {
    const runtime = this.runtime
    if (runtime === undefined) return Promise.reject(new Error('host 未就绪'))
    return listSessions(runtime.url)
  }

  dispose(): void {
    this.disposed = true
    if (this.killTimer !== undefined) clearTimeout(this.killTimer)
    this.stopOnExit()
  }
}
