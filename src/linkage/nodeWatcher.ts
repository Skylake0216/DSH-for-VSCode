/**
 * Node fs.watch 封装的递归目录监听器（跨工作区，纯 node 无 vscode 依赖，node:test 直测）。
 *
 * VSCode 的 FileSystemWatcher 对工作区之外的目录静默失效（vscode#196466 等），
 * 而会话 cwd 可以是任意文件夹 —— 因此用 fs.watch：
 *   - Windows：fs.watch(root, {recursive:true}) 原生递归（Node 19.1+，扩展宿主 Node 20 满足）；
 *   - POSIX：逐目录 watch（跳过 node_modules/.git；rename 出的新目录动态补 watch）。
 * 事件语义：change → 修改；rename → 存在即 create、不存在即 delete。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export type FsEventKind = 'create' | 'change' | 'delete'

/** 跳过监听的高频目录。 */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh', 'dist', 'build'])

export class NodeTreeWatcher {
  private watchers: fs.FSWatcher[] = []
  private handler: ((kind: FsEventKind, absPath: string) => void) | undefined
  /** POSIX 分支：已 watch 的目录集合（防 rename 事件重复补 watch 导致重复事件）。 */
  private watchedDirs = new Set<string>()

  watch(root: string, handler: (kind: FsEventKind, absPath: string) => void): void {
    this.dispose()
    this.handler = handler
    if (process.platform === 'win32') {
      try {
        const watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
          if (typeof filename !== 'string' || filename === '') return
          this.dispatch(eventType, path.join(root, filename))
        })
        watcher.on('error', () => {
          /* 目录被删除等情况：静默 */
        })
        this.watchers.push(watcher)
      } catch {
        /* root 不存在等 */
      }
      return
    }
    this.watchDirRecursive(root)
  }

  private dispatch(eventType: string, absPath: string): void {
    let kind: FsEventKind
    if (eventType === 'rename') {
      kind = fs.existsSync(absPath) ? 'create' : 'delete'
    } else {
      kind = 'change'
    }
    try {
      this.handler?.(kind, absPath)
    } catch {
      /* handler 异常不外抛 */
    }
  }

  private watchDirRecursive(dir: string): void {
    const key = dir.toLowerCase()
    if (this.watchedDirs.has(key)) return
    this.watchedDirs.add(key)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    try {
      const watcher = fs.watch(dir, (eventType, filename) => {
        const name = typeof filename === 'string' ? filename : null
        if (name === null || name === '') return
        const absPath = path.join(dir, name)
        // 新建目录：动态补 watch（POSIX）
        try {
          if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory() && !SKIP_DIRS.has(name)) {
            this.watchDirRecursive(absPath)
          }
        } catch {
          /* ignore */
        }
        this.dispatch(eventType, absPath)
      })
      watcher.on('error', () => {
        /* ignore */
      })
      this.watchers.push(watcher)
    } catch {
      /* ignore */
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      this.watchDirRecursive(path.join(dir, entry.name))
    }
  }

  dispose(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        /* ignore */
      }
    }
    this.watchers = []
    this.watchedDirs.clear()
    this.handler = undefined
  }
}
