import { describe, expect, it } from 'bun:test'
import { buildForwardUploadUrl } from '../tus/doForward.ts'

describe('buildForwardUploadUrl', () => {
  it('rejects path traversal in forwarded PATCH URLs', () => {
    const url = new URL('https://example.com/files/attachments/safe/key')
    const result = buildForwardUploadUrl(url, 'PATCH', 'attachments', 'safe/../other')
    expect(result).toBeNull()
  })

  it('encodes segments for PATCH', () => {
    const url = new URL('https://example.com/files/attachments/raw')
    const result = buildForwardUploadUrl(url, 'PATCH', 'attachments', 'my/file.bin')
    expect(result).toBe('https://example.com/files/attachments/my/file.bin')
  })
})
