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

describe('upload key binding', () => {
  it('rejects PATCH when the path key differs from creation', async () => {
    const handler = new UploadHandler(createMockState({
      'upload-offset': 0,
      'upload-info': { uploadLength: 10, r2Key: 'authorized/key' },
    }), { ATTACHMENT_BUCKET: {} as any, AUTH_TOKEN: 'x' })

    const response = await handler.fetch(new Request('http://do/files/attachments/evil/key', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        'Tus-Resumable': '1.0.0',
      },
      body: new Uint8Array(1),
    }))

    expect(response.status).toBe(400)
  })
})
