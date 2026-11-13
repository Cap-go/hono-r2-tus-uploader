// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { Buffer } from 'node:buffer'
import { HTTPException } from 'hono/http-exception'
import type { R2Bucket } from '@cloudflare/workers-types'

export const REQUEST_METHODS = ['POST', 'HEAD', 'PATCH', 'OPTIONS', 'DELETE'] as const

export const HEADERS = [
  'Authorization',
  'Content-Type',
  'Location',
  'Tus-Extension',
  'Tus-Max-Size',
  'Tus-Resumable',
  'Tus-Version',
  'Upload-Concat',
  'Upload-Defer-Length',
  'Upload-Length',
  'Upload-Metadata',
  'Upload-Offset',
  'X-HTTP-Method-Override',
  'X-Requested-With',
  'X-Forwarded-Host',
  'X-Forwarded-Proto',
  'Forwarded',
] as const

export const HEADERS_LOWERCASE = HEADERS.map((header) => {
  return header.toLowerCase()
}) as Array<Lowercase<(typeof HEADERS)[number]>>

export const TUS_VERSION = '1.0.0'

export const MAX_UPLOAD_LENGTH_BYTES = 1024 * 1024 * 100

export const X_CHECKSUM_SHA256 = 'X-Checksum-Sha256'

export const X_UPLOAD_HANDLER_RETRYABLE = 'X-Capgo-DO-Retryable'

export const NO_TRANSFORM_CACHE_CONTROL = 'no-transform'

export const UPLOAD_OFFSET_KEY = 'upload-offset'

export const UPLOAD_INFO_KEY = 'upload-info'

export const ALLOWED_HEADERS = HEADERS.join(', ')
export const ALLOWED_METHODS = REQUEST_METHODS.join(', ')
export const EXPOSED_HEADERS = HEADERS.join(', ')

export function encodeR2KeyForUploadLocation(r2Key: string): string {
  return r2Key.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

const ENCODED_DOT_RE = /%2e/gi

function isDotPathSegment(segment: string): boolean {
  const normalized = segment.replace(ENCODED_DOT_RE, '.')
  return normalized === '.' || normalized === '..'
}

export function isSafeAttachmentKey(key: string): boolean {
  if (!key || key.startsWith('/') || key.includes('\\') || key.includes('\0') || /%(?:2f|5c)/i.test(key))
    return false

  return key.split('/').every(segment => segment !== '' && !isDotPathSegment(segment))
}

export function decodeUploadLocationKey(encodedKey: string): string | null {
  try {
    return encodedKey.split('/').map(segment => decodeURIComponent(segment)).join('/')
  }
  catch {
    return null
  }
}

export function withNoTransformCacheControl(cacheControl: string | null | undefined): string {
  if (cacheControl == null || cacheControl.trim() === '') {
    return NO_TRANSFORM_CACHE_CONTROL
  }

  const directives = cacheControl
    .split(',')
    .map(directive => directive.trim().toLowerCase())
    .filter(Boolean)

  if (directives.includes(NO_TRANSFORM_CACHE_CONTROL)) {
    return cacheControl
  }

  return `${cacheControl}, ${NO_TRANSFORM_CACHE_CONTROL}`
}

export function buildFileHttpMetadata(contentType?: string, cacheControl?: string | null): import('@cloudflare/workers-types').R2HTTPMetadata {
  return {
    ...(contentType ? { contentType } : {}),
    cacheControl: withNoTransformCacheControl(cacheControl),
  }
}

function getErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return ''
  }

  const { message } = error as { message?: unknown }
  return typeof message === 'string' ? message.toLowerCase() : ''
}

export function isRetryableDurableObjectResetError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const candidate = error as { retryable?: boolean, durableObjectReset?: boolean, overloaded?: boolean }
    if (candidate.retryable || candidate.durableObjectReset || candidate.overloaded) {
      return true
    }
  }

  const message = getErrorMessage(error)
  return [
    'moved to a different machine',
    'storage operation exceeded timeout',
    'caused object to be reset',
    'internal error; reference',
  ].some(fragment => message.includes(fragment))
}
export function readIntFromHeader(headers: Headers, name: string): number {
  const headerString = headers.get(name)
  if (headerString == null) {
    return Number.NaN
  }
  return Number.parseInt(headerString)
}

export function toBase64(v: Uint8Array | ArrayBuffer): string {
  if (v instanceof Uint8Array) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
  }
  else {
    return Buffer.from(v).toString('base64')
  }
}

// Parse binary data from a base64 string
export function fromBase64(s: string): Uint8Array | undefined {
  try {
    return Buffer.from(s, 'base64')
  }
  catch (err) {
    return undefined
  }
}

export class WritableStreamBuffer {
  buf: ArrayBuffer
  offset: number

  constructor(buf: ArrayBuffer) {
    this.buf = buf
    this.offset = 0
  }

  write(chunk: Uint8Array) {
    const remaining = this.buf.byteLength - this.offset
    if (chunk.byteLength > remaining) {
      throw new RangeError('chunk does not fit')
    }
    this.writeUpTo(chunk)
  }

  writeUpTo(chunk: Uint8Array): number {
    const remaining = this.buf.byteLength - this.offset
    const toWrite = Math.min(remaining, chunk.byteLength)
    new Uint8Array(this.buf, this.offset).set(chunk.subarray(0, toWrite))
    this.offset += toWrite
    return toWrite
  }

  view(): Uint8Array {
    return new Uint8Array(this.buf, 0, this.offset)
  }

  reset() {
    this.offset = 0
  }
}

export interface IntermediatePart {
  kind: 'intermediate'
  bytes: Uint8Array
}

export interface FinalPart {
  kind: 'final'
  bytes: Uint8Array
}

export interface ErrorPart {
  kind: 'error'
  error: HTTPException
  bytes: Uint8Array
}

export type Bindings = {
  ATTACHMENT_BUCKET: R2Bucket
  AUTH_TOKEN: string
}


export type Part = IntermediatePart | FinalPart | ErrorPart

// Take an arbitrary length stream and fill an in-memory buffer, emitting a view of the buffer every time the buffer
// is filled. After emitting an item the buffer is reused, so the caller must finish using the buffer before it
// continues iterating.
//
// If an error is encountered reading the stream, the final part generated by the stream will be an error part
// containing whatever was read before the error was encountered.
export async function* generateParts(body: ReadableStream<Uint8Array>, mem: WritableStreamBuffer): AsyncGenerator<Part> {
  try {
    // @ts-expect-error: ReadableStream is not iterable
    for await (let chunk of body) {
      while (chunk.byteLength > 0) {
        const copied = mem.writeUpTo(chunk)
        chunk = chunk.subarray(copied, chunk.byteLength)

        // When we've filled mem, we want to emit a part. But we should only do it if we know
        // there's more body to write. Otherwise, if the upload size is exactly the part size
        // we would end up emitting an empty 'final' part which is unnecessary.
        if (chunk.byteLength > 0 && mem.offset >= mem.buf.byteLength) {
          // the memory buffer's position is at its total length
          yield { kind: 'intermediate', bytes: mem.view() }
          mem.reset()
        }
      }
    }
    yield { kind: 'final', bytes: mem.view() }
  }
  catch (e) {
    const msg = `error reading request body: ${e}`
    console.debug(msg)
    yield { kind: 'error', bytes: mem.view(), error: new HTTPException(400, { message: msg }) }
  }
  mem.reset()
}

export type Release = () => void

export class AsyncLock {
  p: Promise<void> | null

  constructor() {
    this.p = null
  }

  // Asynchronously wait for our turn to execute. Returns Release which should be called
  // when the critical section has completed
  async lock(): Promise<Release> {
    // If there is no active promise we can acquire the lock. We loop since
    // someone else may grab the lock before us, in that case we go back
    // to waiting
    while (this.p != null) {
      await this.p
    }
    let resolver: (value: (void | PromiseLike<void>)) => void
    this.p = new Promise((resolve) => {
      resolver = resolve
    })
    return () => {
      this.p = null
      resolver()
    }
  }
}
