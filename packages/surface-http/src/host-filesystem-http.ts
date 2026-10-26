import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostFilePreviewResponseDto } from '@agent-lens/protocol'
import { statusCodeForError, writeJson } from './http-utils'

/** The single existing desktop/host filesystem handler. Both v38 and Slim
 * use the same headers, validations and explicit-user-action callbacks.
 */
export async function handleHostFilesystemRequest(
  request:IncomingMessage,
  response:ServerResponse,
  url:URL,
  options:{
    openHostPath?:(path:string)=>Promise<'opened'|'revealed'>
    previewHostFile?:(path:string)=>Promise<HostFilePreviewResponseDto>
  },
):Promise<boolean>{
      if (url.pathname === '/api/v1/host/file-preview') {
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'method_not_allowed' })
          return true
        }
        if (!options.previewHostFile) {
          writeJson(response, 501, {
            error: 'desktop_host_required',
            message: '当前运行环境不支持预览本地文件。',
          })
          return true
        }
        const rawPath = request.headers['x-agentlens-host-file-preview-path']
        if (Array.isArray(rawPath)) {
          writeJson(response, 400, {
            error: 'file_preview_failed',
            message: '目标文件请求头无效。',
          })
          return true
        }
        let path = ''
        try {
          path = rawPath ? decodeURIComponent(rawPath).trim() : ''
        } catch {
          path = ''
        }
        if (!path) {
          writeJson(response, 400, {
            error: 'file_preview_failed',
            message: '目标文件路径无效。',
          })
          return true
        }
        try {
          writeJson(response, 200, await options.previewHostFile(path))
        } catch (error) {
          const statusCode = statusCodeForError(error)
          writeJson(response, statusCode, {
            error: 'file_preview_failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        return true
      }

      if (url.pathname === '/api/v1/host/open-path' || url.pathname === '/api/v1/host/open-directory') {
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'method_not_allowed' })
          return true
        }
        const generic = url.pathname === '/api/v1/host/open-path'
        const rawResult = request.headers[
          generic ? 'x-agentlens-host-open-path-result' : 'x-agentlens-host-open-directory-result'
        ]
        const result = Array.isArray(rawResult) ? rawResult[0] : rawResult
        if (result === 'opened' || result === 'revealed') {
          writeJson(response, 200, {
            opened: true,
            action: result === 'revealed' ? 'revealed' : 'opened',
          })
          return true
        }
        if (!result && options.openHostPath) {
          const rawPath = request.headers[
            generic ? 'x-agentlens-host-open-path-path' : 'x-agentlens-host-open-directory-path'
          ]
          if (Array.isArray(rawPath)) {
            writeJson(response, 400, {
              error: generic ? 'open_path_failed' : 'open_directory_failed',
              message: '目标路径请求头无效。',
            })
            return true
          }
          let path = ''
          try {
            path = rawPath ? decodeURIComponent(rawPath).trim() : ''
          } catch {
            path = ''
          }
          if (!path) {
            writeJson(response, 400, {
              error: generic ? 'open_path_failed' : 'open_directory_failed',
              message: '目标路径无效。',
            })
            return true
          }
          try {
            const action = await options.openHostPath(path)
            writeJson(response, 200, { opened: true, action })
          } catch (error) {
            writeJson(response, 400, {
              error: generic ? 'open_path_failed' : 'open_directory_failed',
              message: error instanceof Error ? error.message : String(error),
            })
          }
          return true
        }
        if (!result) {
          writeJson(response, 501, {
            error: 'desktop_host_required',
            message: '当前运行环境不支持直接定位本地路径。',
          })
          return true
        }
        const message = result.startsWith('open-error:')
          ? decodeURIComponent(result.slice('open-error:'.length))
          : result === 'missing'
            ? '目标路径不存在或无法访问。'
            : result === 'unsupported-path'
              ? '当前路径类型不支持在文件管理器中打开。'
              : result === 'not-directory'
                ? '目标路径不是目录。'
                : '目标路径无效。'
        writeJson(response, 400, {
          error: generic ? 'open_path_failed' : 'open_directory_failed',
          message,
        })
        return true
      }


  return false
}
