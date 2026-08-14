/**
 * DSH host /api RPC 的最小客户端：只封装扩展需要的 session.list。
 * 信封格式（已对真实实例验证）：
 *   request : { type:'client-request', rpcId, method, payload }
 *   response: { type:'server-response', rpcId, result:{ ok:true, value } | { ok:false, error } }
 * 信任栅栏：Host 为回环 + 无 Origin 的本地请求放行。
 */
import { randomUUID } from 'node:crypto'

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
}

interface RpcEnvelope {
  type: 'server-response'
  rpcId: string
  result: { ok: true; value: { items: SessionSummary[] } } | { ok: false; error: { message?: string } }
}

export class DshApiError extends Error {}

/**
 * POST 一个 unary RPC。baseUrl 形如 http://127.0.0.1:<port>。
 * @throws DshApiError 在传输失败或结果非 ok 时。
 */
export async function rpc<T>(baseUrl: string, method: string, payload: unknown, timeoutMs = 10_000): Promise<T> {
  const body = JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload })
  let response: Response
  try {
    response = await fetch(`${baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new DshApiError(`DSH API 不可达（${baseUrl}）：${String(error)}`)
  }
  let envelope: RpcEnvelope
  try {
    envelope = (await response.json()) as RpcEnvelope
  } catch {
    throw new DshApiError(`DSH API 响应非 JSON（${method}，HTTP ${response.status}）`)
  }
  if (envelope.type !== 'server-response' || envelope.result.ok !== true) {
    const message = 'error' in envelope.result && envelope.result.error ? envelope.result.error.message ?? 'unknown' : 'malformed'
    throw new DshApiError(`DSH API ${method} 失败：${message}`)
  }
  return envelope.result.value as T
}

/** session.list：全部会话摘要（含 cwd）。 */
export function listSessions(baseUrl: string): Promise<{ items: SessionSummary[] }> {
  return rpc<{ items: SessionSummary[] }>(baseUrl, 'session.list', {})
}

/** 按 activity 顺序取"最可能的活动会话"（running 优先，其次 updatedAt 最新）。 */
export function pickLikelyActive(items: SessionSummary[]): SessionSummary | undefined {
  const candidates = items.filter((item) => !item.blank && item.cwd !== undefined && item.cwd !== '')
  if (candidates.length === 0) return undefined
  const running = candidates.filter((item) => item.running)
  if (running.length > 0) return running.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
  return candidates.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
}
