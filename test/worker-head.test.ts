import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono/tiny'
import type { Context } from 'hono'

describe('worker HEAD routing (hono/tiny)', () => {
  it('forwards HEAD on GET route to TUS upload handler', async () => {
    const calls: string[] = []

    async function uploadHandler() {
      calls.push('upload')
      return new Response(null, {
        status: 200,
        headers: { 'Upload-Offset': '42', 'Tus-Resumable': '1.0.0' },
      })
    }

    async function getHandler(c: Context) {
      if (c.req.method === 'HEAD') {
        return uploadHandler()
      }
      calls.push('get')
      return c.text('download')
    }

    const app = new Hono()
    app.get('/files/attachments/:id{.+}', getHandler)

    const response = await app.request('http://localhost/files/attachments/my-file', { method: 'HEAD' })

    expect(calls).toEqual(['upload'])
    expect(response.status).toBe(200)
    expect(response.headers.get('Upload-Offset')).toBe('42')
    expect(await response.text()).toBe('')
  })
})
