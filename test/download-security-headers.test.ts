import { describe, expect, it } from 'bun:test'
import { applyDownloadSecurityHeaders } from '../index.ts'

describe('applyDownloadSecurityHeaders', () => {
  it('sets nosniff and a sandbox CSP without dropping other headers', () => {
    const headers = new Headers({ 'content-type': 'text/html', etag: '"abc"' })
    applyDownloadSecurityHeaders(headers)
    expect(headers.get('content-type')).toBe('text/html')
    expect(headers.get('etag')).toBe('"abc"')
    expect(headers.get('x-content-type-options')).toBe('nosniff')
    expect(headers.get('content-security-policy')).toBe('sandbox')
  })
})
