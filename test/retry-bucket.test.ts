import { describe, expect, it } from 'bun:test'
import { RetryBucket } from '../tus/retry.ts'

describe('RetryBucket.createMultipartUpload', () => {
  it('retries a transient R2 internal error', async () => {
    const r2Upload = { key: 'my-file', uploadId: 'upload-id' }
    let calls = 0
    const bucket = {
      createMultipartUpload: async () => {
        calls++
        if (calls === 1)
          throw new Error('createMultipartUpload: We encountered an internal error. Please try again. (10001)')
        return r2Upload
      },
    } as any

    const upload = await new RetryBucket(bucket, { maxRetries: 5, durationMillis: 1 }).createMultipartUpload('my-file')

    expect(calls).toBe(2)
    expect(upload.r2MultipartUpload).toBe(r2Upload as any)
  })

  it('throws after the maximum number of retries', async () => {
    let calls = 0
    const bucket = {
      createMultipartUpload: async () => {
        calls++
        throw new Error('createMultipartUpload: We encountered an internal error. Please try again. (10001)')
      },
    } as any

    await expect(new RetryBucket(bucket, { maxRetries: 2, durationMillis: 1 }).createMultipartUpload('my-file')).rejects.toThrow('10001')
    expect(calls).toBe(3)
  })
})
