/**
 * 文件联动监听器（跨工作区目录）。
 *
 * VSCode 的 FileSystemWatcher 对工作区之外的目录静默失效（vscode#196466 等），
 * 而会话 cwd 可以是任意文件夹 —— 因此这里用 Node fs.watch：
 *   - Windows：fs.watch(root, {recursive:true}) 原生递归（Node 19.1+，扩展宿主 Node 20 满足）；
 *   - POSIX：逐目录 watch（跳过 node_modules/.git；rename 出的新目录动态补 watch）。
 * 事件语义：change → 修改；rename → 存在即 create、不存在即 delete。
 *
 * 策略（dirty 红线不变）：
 *   - create/change → decideOpen：未打开→按 autoOpenFiles 打开（preview/editor），
 *     open+dirty → 永不覆盖（状态栏提示）；open+clean → VSCode 原生刷新，不干预。
 *   - delete → 关闭该文件的已打开 tab（dirty 保留）。
 *   - 活动会话 cwd 变化 → watch(newRoot) 热切换。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { decideOpen, inAutoOpenScope, type OpenMode } from './policy'
import { openInVscode } from './opener'
import { NodeTreeWatcher, SKIP_DIRS, type FsEventKind } from './nodeWatcher'

export interface WatcherOptions {
  getOpenMode(): OpenMode
  getInclude(): string[]
  getExclude(): string[]
  /** 关闭被删除文件的 tab（默认 true）。 */
  closeOnDelete(): boolean
  /** 自动打开是否保留焦点（默认 true=不抢焦点）。 */
  preserveFocus(): boolean
  /** 打开文件回调（依赖注入：测试可替换）。 */
  openFile(uri: vscode.Uri, preview: boolean, preserveFocus: boolean): Thenable<void>
  /** 跳过 dirty 文件的提示回调（依赖注入）。 */
  notifyDirty(uri: vscode.Uri): void
  log(message: string): void
}

export class LinkageWatcher implements vscode.Disposable {
  private tree = new NodeTreeWatcher()
  private root: string | undefined
  private pending = new Map<string, ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(private readonly options: WatcherOptions) {}

  /** 当前监视根。 */
  get currentRoot(): string | undefined {
    return this.root
  }

  /** 重绑监视根（root 相同则 no-op；undefined 时停用）。 */
  watch(root: string | undefined): void {
    if (root === this.root) return
    this.clearPending()
    this.tree.dispose()
    this.root = root
    if (root === undefined || root === '') return
    this.options.log(`watcher: watching ${root}`)
    this.tree.watch(root, (kind, absPath) => this.handleFsEvent(kind, absPath))
  }

  /** 外部操作产生的变化也走同一路径（如未来 bridge 事件流接入）。 */
  externalChange(absPath: string): void {
    this.handleFsEvent('change', absPath)
  }

  private clearPending(): void {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }

  private handleFsEvent(kind: FsEventKind, absPath: string): void {
    if (this.disposed || this.root === undefined) return
    const rel = this.relPath(absPath)
    // 根外路径（POSIX 动态补 watch 的边界/未来事件源）与高频目录首段：直接丢弃。
    if (rel.startsWith('..')) return
    const firstSegment = rel.split(path.sep)[0] ?? ''
    if (SKIP_DIRS.has(firstSegment.toLowerCase())) return
    // 大小写合并仅 Windows/mac 有意义；POSIX 上 a.ts 与 A.ts 是两个文件。
    const key = process.platform === 'linux' ? absPath : absPath.toLowerCase()
    const existing = this.pending.get(key)
    if (existing !== undefined) clearTimeout(existing)
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key)
        void this.decide(kind, absPath)
      }, 200)
    )
  }

  private relPath(absPath: string): string {
    const root = this.root ?? ''
    const rel = path.relative(root, absPath)
    return rel === '' ? path.basename(absPath) : rel
  }

  private async decide(kind: FsEventKind, absPath: string): Promise<void> {
    const root = this.root
    if (this.disposed || root === undefined) return

    if (kind === 'delete') {
      // delete 竞态复查：防抖窗口内文件可能已重建（staged 写入的 del+rename 模式）——
      // 仍存在则不关 tab（dirty 红线在 closeTabFor 内仍兜底）。
      if (!fs.existsSync(absPath)) this.closeTabFor(absPath)
      return
    }

    // 事件到达时文件可能已被后续 rename 顶掉：以当前磁盘状态为准。
    if (!fs.existsSync(absPath)) return
    try {
      if (fs.statSync(absPath).isDirectory()) return // 目录事件（如子目录 mtime 变化）：忽略
    } catch {
      return
    }
    const rel = this.relPath(absPath)
    if (!inAutoOpenScope(rel, this.options.getInclude(), this.options.getExclude())) return

    const openMode = this.options.getOpenMode()
    if (openMode === 'off') return

    const uri = vscode.Uri.file(absPath)
    const openDoc = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.fsPath.toLowerCase() === absPath.toLowerCase() && doc.isClosed !== true
    )
    const isOpen = openDoc !== undefined
    const isDirty = openDoc?.isDirty ?? false

    const decision = decideOpen(openMode, isOpen, isDirty, false)
    if (decision.action === 'skip') {
      if (decision.reason === 'open-dirty') this.options.notifyDirty(uri)
      return
    }
    try {
      await this.options.openFile(uri, decision.preview, this.options.preserveFocus())
    } catch (error) {
      this.options.log(`watcher: open failed for ${absPath}: ${String(error)}`)
    }
  }

  private closeTabFor(absPath: string): void {
    if (!this.options.closeOnDelete()) return
    const key = absPath.toLowerCase()
    const openDoc = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.fsPath.toLowerCase() === key && doc.isClosed !== true
    )
    if (openDoc !== undefined && openDoc.isDirty) return // dirty 红线
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input
        if (input instanceof vscode.TabInputText && input.uri.fsPath.toLowerCase() === key) {
          void vscode.window.tabGroups.close(tab)
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.clearPending()
    this.tree.dispose()
  }
}

/** 默认实现：真实打开文件（依赖注入在测试中替换）。 */
export const defaultOpenFile = async (uri: vscode.Uri, preview: boolean, preserveFocus: boolean): Promise<void> => {
  await openInVscode(uri, { preview, preserveFocus })
}
