/**
 * 编辑器打开：路径解析（pathSafety）+ showTextDocument + 消息入口。
 */
import * as vscode from 'vscode'
import { resolveSafePath } from './pathSafety'

export interface OpenOptions {
  preview: boolean
  preserveFocus: boolean
  line?: number
  column?: number
}

/** 在 VSCode 打开文件（带行列）。 */
export async function openInVscode(uri: vscode.Uri, options: OpenOptions): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri)
  const selection =
    options.line !== undefined && options.line > 0
      ? new vscode.Range(
          new vscode.Position(options.line - 1, Math.max(0, (options.column ?? 0) - 1)),
          new vscode.Position(options.line - 1, Math.max(0, (options.column ?? 0) - 1))
        )
      : undefined
  await vscode.window.showTextDocument(document, {
    preview: options.preview,
    preserveFocus: options.preserveFocus,
    selection,
  })
}

/** 从消息输入打开文件：路径解析 + 打开。 */
export async function openFromMessage(
  input: string,
  roots: string[],
  options: { preview?: boolean; line?: number; column?: number }
): Promise<'ok' | 'outside' | 'failed'> {
  const resolved = resolveSafePath(input, roots)
  if (resolved === undefined) return 'outside'
  try {
    await openInVscode(vscode.Uri.file(resolved), {
      preview: options.preview ?? false,
      preserveFocus: true,
      line: options.line,
      column: options.column,
    })
    return 'ok'
  } catch {
    return 'failed'
  }
}

export { resolveSafePath }
