import { describe, expect, it } from 'bun:test'
import { decodeUploadLocationKey, encodeR2KeyForUploadLocation, isSafeAttachmentKey } from '../tus/util.ts'

describe('isSafeAttachmentKey', () => {
  it('accepts normal keys', () => {
    expect(isSafeAttachmentKey('attachments/demo.bin')).toBe(true)
  })

  it('rejects dot segments', () => {
    expect(isSafeAttachmentKey('a/../b')).toBe(false)
    expect(isSafeAttachmentKey('a/%2e%2e/b')).toBe(false)
  })

  it('rejects encoded path separators', () => {
    expect(isSafeAttachmentKey('a%2fb')).toBe(false)
  })
})

describe('encodeR2KeyForUploadLocation', () => {
  it('round trips through decodeUploadLocationKey', () => {
    const key = 'orgs/acme/apps/com.app/file name.bin'
    const encoded = encodeR2KeyForUploadLocation(key)
    expect(decodeUploadLocationKey(encoded)).toBe(key)
  })
})
