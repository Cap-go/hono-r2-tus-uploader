import { describe, expect, it } from 'bun:test'
import { DEFAULT_RETRY_PARAMS, RetryBucket } from '../tus/retry.ts'
import { UPLOAD_INFO_KEY, UPLOAD_OFFSET_KEY, TUS_VERSION } from '../tus/util.ts'

const BUFFER_SIZE = 1024 * 1024 * 5
import { UploadHandler } from '../tus/uploadHandler.ts'

describe('TUS upload when R2 multipart session is missing', () => {
  it('returns 409 and follow-up HEAD is 404', async () => {
    const multipartMissingError = new Error('uploadPart: The specified multipart upload does not exist. (10024)')
    const uploadPartMock = async () => {
      throw multipartMissingError
    }

    const r2MultipartUpload = {
      uploadId: 'upload-id-1',
      uploadPart: uploadPartMock,
      abort: async () => {},
      complete: async () => {},
    }

    const mockBucket = {
      createMultipartUpload: async () => r2MultipartUpload,
      resumeMultipartUpload: () => r2MultipartUpload,
      head: async () => null,
      get: async () => null,
      delete: async () => {},
      put: async () => {},
    }

    const storageMap = new Map<string, unknown>()
    const storage = {
      get: async (key: string) => storageMap.get(key),
      put: async (key: string, value: unknown) => { storageMap.set(key, value) },
      deleteAll: async () => { storageMap.clear() },
      deleteAlarm: async () => {},
      getAlarm: async () => Date.now() + 86_400_000,
      setAlarm: async () => {},
    }

    storageMap.set(UPLOAD_OFFSET_KEY, 0)
    storageMap.set(UPLOAD_INFO_KEY, { uploadLength: BUFFER_SIZE * 10, r2Key: 'bundle.zip' })

    const handler = new UploadHandler({ id: { toString: () => 'test' }, storage } as any, {
      ATTACHMENT_BUCKET: mockBucket as any,
      AUTH_TOKEN: 'token',
    })
    handler.retryBucket = new RetryBucket(mockBucket as any, DEFAULT_RETRY_PARAMS)

    const r2Key = 'bundle.zip'
    const patchResponse = await handler.fetch(new Request(`http://localhost/files/attachments/${r2Key}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/offset+octet-stream',
        'Tus-Resumable': TUS_VERSION,
        'Upload-Length': String(BUFFER_SIZE * 10),
        'Upload-Offset': '0',
      },
      body: new Uint8Array(BUFFER_SIZE + 1),
    }))

    expect(patchResponse.status).toBe(409)

    const headResponse = await handler.fetch(new Request(`http://localhost/files/attachments/${r2Key}`, {
      method: 'HEAD',
    }))

    expect(headResponse.status).toBe(404)
  })
})
