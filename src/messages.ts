/**
 * 消息协议：iframe(bridge.js) ⇄ webview(relay.ts) ⇄ 扩展宿主(extension.ts)。
 * 全部 JSON；消息必须带 type；跨框消息必须校验 source 与来源窗口。
 */

/** iframe 内 bridge.js → window.parent（webview relay 脚本）的消息。 */
export type IframeToWebview =
  | {
      source: 'dsh-vscode'
      type: 'openFile'
      /** 相对路径（相对活动会话 cwd）或绝对路径。 */
      path: string
      line?: number
      column?: number
    }
  | {
      source: 'dsh-vscode'
      type: 'sessionCurrent'
      /** DSH 前端当前会话 id（可能为 null/字符串）；宿主据此解析 cwd。 */
      sessionId: string | null
    }

/** webview relay → 扩展宿主。 */
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'iframeLoaded' }
  | {
      type: 'openFile'
      path: string
      line?: number
      column?: number
    }
  | {
      type: 'sessionCurrent'
      sessionId: string | null
    }
  | {
      /** relay 内部诊断回传（调试 connect 面板卡死用）。 */
      type: 'relayDiag'
      step: string
      url?: string
    }

/** 扩展宿主 → webview relay。 */
export type HostToWebview =
  | { type: 'hello'; url: string }
  | { type: 'hostStatus'; status: 'connecting' | 'connected' | 'error'; message?: string }

/** 窗口级消息常量。 */
export const IFRAME_SOURCE = 'dsh-vscode' as const

/** 从任意 unknown 值守卫为 IframeToWebview（relay 使用）。 */
export function isIframeToWebview(value: unknown): value is IframeToWebview {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.source !== IFRAME_SOURCE) return false
  if (record.type === 'openFile') {
    return (
      typeof record.path === 'string' &&
      (record.line === undefined || typeof record.line === 'number') &&
      (record.column === undefined || typeof record.column === 'number')
    )
  }
  if (record.type === 'sessionCurrent') return record.sessionId === null || typeof record.sessionId === 'string'
  return false
}
