import type { DurableObjectStub } from '@cloudflare/workers-types'
import {
  decodeUploadLocationKey,
  encodeR2KeyForUploadLocation,
  isRetryableDurableObjectResetError,
  isSafeAttachmentKey,
  TUS_VERSION,
  X_UPLOAD_HANDLER_RETRYABLE,
} from './util.ts'

export const DO_CALL_TIMEOUT = 1000 * 60 * 30
const DO_FETCH_RETRY_ATTEMPTS = 3
const DO_FETCH_RETRY_DELAY_MS = 250

function readIntHeader(request: Request, name: string): number | null {
  const headerString = request.headers.get(name)
  if (headerString == null) {
    return null
  }
  return Number.parseInt(headerString)
}

function isZeroLengthTusUploadBody(request: Request): boolean {
  const contentLength = readIntHeader(request, 'content-length')
  return contentLength === 0
}

function requestHasNonEmptyUploadBody(request: Request): boolean {
  if (request.body == null) {
    return false
  }

  if (request.headers.has('transfer-encoding')) {
    return true
  }

  const contentLength = readIntHeader(request, 'content-length')
  if (contentLength == null) {
    return true
  }

  return Number.isNaN(contentLength) || contentLength > 0
}

export function getForwardedUploadBody(request: Request): ReadableStream<Uint8Array> | ArrayBuffer | null {
  if (request.method === 'HEAD') {
    return null
  }

  if (isZeroLengthTusUploadBody(request)) {
    return new ArrayBuffer(0)
  }

  return requestHasNonEmptyUploadBody(request)
    ? request.body as ReadableStream<Uint8Array>
    : null
}

function canReplayUploadRequest(request: Request): boolean {
  return request.method === 'HEAD' || !requestHasNonEmptyUploadBody(request)
}

function buildDurableObjectRequest(request: Request): Request {
  const requestInit: RequestInit & { duplex?: 'half' } = {
    headers: request.headers,
    method: request.method,
    signal: AbortSignal.timeout(DO_CALL_TIMEOUT),
  }

  const uploadBody = getForwardedUploadBody(request)
  if (uploadBody != null) {
    requestInit.body = uploadBody
    requestInit.duplex = 'half'
  }

  return new Request(request.url, requestInit)
}

function isRetryableDurableObjectResponse(response: Response): boolean {
  return response.headers.get(X_UPLOAD_HANDLER_RETRYABLE) === '1'
}

function retryableUploadUnavailableResponse(): Response {
  return new Response(JSON.stringify({
    error: 'upload_retryable',
    message: 'Upload temporarily unavailable. Retry the upload request.',
  }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': '1',
      'Tus-Resumable': TUS_VERSION,
    },
  })
}

export function buildForwardUploadUrl(requestUrl: URL, method: string, attachmentPrefix: string, normalizedRequestId: string): string | null {
  if (method !== 'HEAD' && method !== 'PATCH') {
    return requestUrl.toString()
  }

  const uploadPrefix = `/files/${attachmentPrefix}/`
  const prefixIndex = requestUrl.pathname.indexOf(uploadPrefix)
  if (prefixIndex < 0) {
    return requestUrl.toString()
  }

  const routePrefix = requestUrl.pathname.slice(0, prefixIndex + uploadPrefix.length)
  requestUrl.pathname = `${routePrefix}${encodeR2KeyForUploadLocation(normalizedRequestId)}`
  const forwardedKey = requestUrl.pathname.startsWith(routePrefix)
    ? decodeUploadLocationKey(requestUrl.pathname.slice(routePrefix.length))
    : null
  if (!isSafeAttachmentKey(normalizedRequestId) || forwardedKey !== normalizedRequestId) {
    return null
  }

  return requestUrl.toString()
}

export async function fetchUploadHandlerWithRetry(
  handler: DurableObjectStub,
  request: Request,
): Promise<Response> {
  const canRetryRequest = canReplayUploadRequest(request)
  const maxAttempts = canRetryRequest ? DO_FETCH_RETRY_ATTEMPTS : 1

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await handler.fetch(buildDurableObjectRequest(request))

      const shouldRetryResponse = canRetryRequest
        && attempt < maxAttempts
        && isRetryableDurableObjectResponse(response)

      if (shouldRetryResponse) {
        await new Promise(resolve => setTimeout(resolve, DO_FETCH_RETRY_DELAY_MS * attempt))
        continue
      }

      return response
    }
    catch (error) {
      const isRetryable = isRetryableDurableObjectResetError(error)
      const shouldRetry = canRetryRequest && attempt < maxAttempts && isRetryable

      if (!shouldRetry) {
        if (isRetryable) {
          return retryableUploadUnavailableResponse()
        }
        throw error
      }

      await new Promise(resolve => setTimeout(resolve, DO_FETCH_RETRY_DELAY_MS * attempt))
    }
  }

  return retryableUploadUnavailableResponse()
}
