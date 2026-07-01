import { describe, expect, it } from 'bun:test'
import { UploadHandler } from '../tus/uploadHandler.ts'

function createMockState(storageData: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(storageData))
  return {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => { store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
      deleteAll: async () => { store.clear() },
      deleteAlarm: async () => {},
      getAlarm: async () => Date.now() + 60_000,
      setAlarm: async () => {},
    },
    id: { toString: () => 'test-do-id' },
  } as any
}

describe('TUS HEAD resume', () => {
  it('returns Upload-Offset for in-progress uploads on HEAD', async () => {
    const handler = new UploadHandler(createMockState({
      'upload-offset': 42,
      'upload-info': { uploadLength: 100 },
    }), { ATTACHMENT_BUCKET: {} as any, AUTH_TOKEN: 'x' })

    const response = await handler.fetch(new Request('http://do/files/attachments/my-file', {
      method: 'HEAD',
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get('Upload-Offset')).toBe('42')
    expect(response.headers.get('Upload-Length')).toBe('100')
    expect(response.headers.get('Tus-Resumable')).toBe('1.0.0')
  })

  it('does not treat HEAD as GET download route', async () => {
    const bucket = { head: async () => null } as any
    const handler = new UploadHandler(createMockState(), { ATTACHMENT_BUCKET: bucket, AUTH_TOKEN: 'x' })

    const response = await handler.fetch(new Request('http://do/files/attachments/missing', {
      method: 'HEAD',
    }))

    expect(response.status).toBe(404)
  })
})
