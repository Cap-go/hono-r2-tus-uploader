// import { cors } from 'hono/cors'
import { Hono } from 'hono/tiny'
import type { Context, Next } from 'hono'
import { parseUploadMetadata } from './tus/parse.ts'
import { DEFAULT_RETRY_PARAMS, RetryBucket } from './tus/retry.ts'
import { MAX_UPLOAD_LENGTH_BYTES, TUS_VERSION, X_CHECKSUM_SHA256 } from './tus/uploadHandler.ts'
import { ALLOWED_HEADERS, ALLOWED_METHODS, EXPOSED_HEADERS, toBase64 } from './tus/util.ts'
import type { R2Bucket, R2Object, R2Range, DurableObjectNamespace } from '@cloudflare/workers-types'

const DO_CALL_TIMEOUT = 1000 * 60 * 30 // 20 minutes

const ATTACHMENT_PREFIX = 'attachments'

export { AttachmentUploadHandler, UploadHandler } from './tus/uploadHandler.ts'

const app = new Hono()

app.options(`/files/${ATTACHMENT_PREFIX}`, optionsHandler)
app.post(`/files/${ATTACHMENT_PREFIX}`, setKeyFromMetadata, uploadHandler)

app.options(`/files/${ATTACHMENT_PREFIX}/:id{.+}`, optionsHandler)
app.get(`/files/${ATTACHMENT_PREFIX}/:id{.+}`, setKeyFromIdParam, getHandler)
app.patch(`/files/${ATTACHMENT_PREFIX}/:id{.+}`, setKeyFromIdParam, uploadHandler)

app.all('*', (c) => {
  console.log('all upload_bundle', c.req.url)
  return c.json({ error: 'Not Found' }, 404)
})

async function checkAppAccess(c: Context) {
  const authHeader = c.req.header('Authorization');
  if (authHeader !== c.env.AUTH_TOKEN) {
    throw new Error('Unauthorized');
  }

}

function validateRequestId(requestId: string) {
    // here you should check is the path is conform as you expoect for the user and catch path traversal
  if (requestId.includes('..')) {
    throw new Error('Path traversal detected');
  }
  return true
}

async function getHandler(c: Context): Promise<Response> {
  const requestId = c.get('fileId')
  // TODO: check if the user is authorized to access this file for the demo purpose it's disabled
  // try {
  //   validateRequestId(requestId)
  //   await checkAppAccess(c)
  // }
  // catch (error) {
  //   console.log({ requestId: c.get('requestId'), context: 'checkAppAccess', error })
  //   return c.json({ error: (error as any)?.message || 'Unknown error' }, 400)
  // }

  const bucket: R2Bucket = c.env.ATTACHMENT_BUCKET

  if (bucket == null) {
    console.log('getHandler upload_bundle', 'bucket is null')
    return c.json({ error: 'Not Found' }, 404)
  }

  // @ts-expect-error-next-line
  const cache = caches.default
  const cacheKey = new Request(new URL(c.req.url), c.req)
  let response = await cache.match(cacheKey)
  if (response != null) {
    return response
  }

  const object = await new RetryBucket(bucket, DEFAULT_RETRY_PARAMS).get(requestId, {
    range: c.req.raw.headers as any,
  })
  if (object == null) {
    console.log('getHandler upload_bundle', 'object is null')
    return c.json({ error: 'Not Found' }, 404)
  }
  const headers = objectHeaders(object)
  if (object.range != null && c.req.header('range')) {
    headers.set('content-range', rangeHeader(object.size, object.range))
    response = new Response(object.body as any, { headers, status: 206 })
    return response
  }
  else {
    response = new Response(object.body as any, { headers })
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()))
    return response
  }
}

function objectHeaders(object: R2Object): Headers {
  const headers = new Headers()
  object.writeHttpMetadata(headers as any)
  headers.set('etag', object.httpEtag)

  // the sha256 checksum was provided to R2 in the upload
  if (object.checksums.sha256 != null) {
    headers.set(X_CHECKSUM_SHA256, toBase64(object.checksums.sha256))
  }

  // it was a multipart upload, so we were forced to write a sha256 checksum as a custom header
  if (object.customMetadata?.[X_CHECKSUM_SHA256] != null) {
    headers.set(X_CHECKSUM_SHA256, object.customMetadata[X_CHECKSUM_SHA256])
  }
  return headers
}

function rangeHeader(objLen: number, r2Range: R2Range): string {
  let startIndexInclusive = 0
  let endIndexInclusive = objLen - 1
  if ('offset' in r2Range && r2Range.offset != null) {
    startIndexInclusive = r2Range.offset
  }
  if ('length' in r2Range && r2Range.length != null) {
    endIndexInclusive = startIndexInclusive + r2Range.length - 1
  }
  if ('suffix' in r2Range) {
    startIndexInclusive = objLen - r2Range.suffix
  }
  return `bytes ${startIndexInclusive}-${endIndexInclusive}/${objLen}`
}

function optionsHandler(c: Context): Response {
  console.log('optionsHandler upload_bundle', 'optionsHandler')
  return c.newResponse(null, 204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Tus-Resumable': TUS_VERSION,
    'Tus-Version': TUS_VERSION,
    'Tus-Max-Size': MAX_UPLOAD_LENGTH_BYTES.toString(),
    'Tus-Extension': 'creation,creation-defer-length,creation-with-upload,expiration',
  })
}

// TUS protocol requests (POST/PATCH/HEAD) that get forwarded to a durable object
async function uploadHandler(c: Context): Promise<Response> {
  const requestId = c.get('fileId')
  try {
    validateRequestId(requestId)
    await checkAppAccess(c)
  }
  catch (error) {
    console.log({ requestId: c.get('requestId'), context: 'checkAppAccess', error })
    return c.json({ error: (error as any)?.message || 'Unknown error' }, 400)
  }
  // make requestId  safe
  console.log('upload_bundle req', 'uploadHandler', requestId, c.req.method, c.req.url)
  const durableObjNs: DurableObjectNamespace = c.env.ATTACHMENT_UPLOAD_HANDLER

  if (durableObjNs == null) {
    console.log('upload_bundle', 'durableObjNs is null')
    return c.json({ error: 'Invalid bucket configuration' }, 500)
  }

  const handler = durableObjNs.get(durableObjNs.idFromName(requestId))
  console.log('can handler')
  // @ts-expect-error-next-line
  return await handler.fetch(c.req.url, {
    body: c.req.raw.body as any,
    method: c.req.method,
    headers: c.req.raw.headers as any ,
    signal: AbortSignal.timeout(DO_CALL_TIMEOUT) as any,
  })
}

async function setKeyFromMetadata(c: Context, next: Next) {
  const fileId = parseUploadMetadata(c.req.raw.headers).filename
  if (fileId == null) {
    console.log('upload_bundle', 'fileId is null')
    return c.json({ error: 'Not Found' }, 404)
  }
  c.set('fileId', fileId)
  await next()
}

async function setKeyFromIdParam(c: Context, next: Next) {
  const fileId = c.req.param('id')
  if (fileId == null) {
    console.log('upload_bundle', 'fileId is null')
    return c.json({ error: 'Not Found' }, 404)
  }
  c.set('fileId', fileId)
  await next()
}

export default {
  fetch: app.fetch,
}
