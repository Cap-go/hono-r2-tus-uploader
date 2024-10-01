import { join, resolve } from 'node:path'

const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url)
    let path = url.pathname

    if (path === '/') {
      path = '/index.html'
    }

    // Special case for tus.js
    if (path === '/node_modules/tus-js-client/dist/tus.js') {
      const tusFilePath = resolve(process.cwd(), 'node_modules/tus-js-client/dist/tus.js')
      try {
        const content = await Bun.file(tusFilePath).text()
        return new Response(content, { headers: { 'Content-Type': 'application/javascript' } })
      } catch (error) {
        console.error('Error reading tus.js:', error)
        return new Response('404 Not Found', { status: 404 })
      }
    }

    console.log(process.cwd(), path)
    const filePath = join(process.cwd(), 'demo', path)

    try {
      const content = await Bun.file(filePath).text()
      const mimeType = getMimeType(filePath)
      return new Response(content, { headers: { 'Content-Type': mimeType } })
    } catch (error) {
      console.error('Error reading file:', error)
      return new Response('404 Not Found', { status: 404 })
    }
  },
})

function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'html': return 'text/html'
    case 'css': return 'text/css'
    case 'js': return 'application/javascript'
    // Add more mime types as needed
    default: return 'application/octet-stream'
  }
}

console.log(`Listening on ${server.url}`)
