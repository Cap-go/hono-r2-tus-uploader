import { describe, expect, it } from 'bun:test'
import { parseUploadMetadata } from '../tus/parse.ts'

function headersWithMetadata(entries: Record<string, string>): Headers {
  const parts = Object.entries(entries).map(([key, value]) => {
    const encoded = btoa(value)
    return `${key} ${encoded}`
  })
  return new Headers({ 'Upload-Metadata': parts.join(',') })
}

describe('parseUploadMetadata filetype', () => {
  it('stores a plain type/subtype, lowercased, without parameters', () => {
    const parsed = parseUploadMetadata(headersWithMetadata({
      filename: 'clip.bin',
      filetype: 'Text/HTML; charset=UTF-8',
    }))
    expect(parsed.filename).toBe('clip.bin')
    expect(parsed.filetype).toBe('text/html')
  })

  it('ignores empty, invalid, or header-unsafe filetype values without throwing', () => {
    expect(parseUploadMetadata(headersWithMetadata({ filetype: '' })).filetype).toBeUndefined()
    expect(parseUploadMetadata(headersWithMetadata({ filetype: 'not-a-type' })).filetype).toBeUndefined()
    expect(parseUploadMetadata(headersWithMetadata({ filetype: 'text/html\r\nX-Injected: 1' })).filetype).toBeUndefined()
  })
})
