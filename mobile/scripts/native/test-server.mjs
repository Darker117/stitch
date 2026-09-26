// Download edge cases for the on-device test (android/app/src/androidTest/.../DeviceRuntimeTest.kt):
//   node scripts/native/test-server.mjs   then   adb reverse tcp:8765 tcp:8765
// /ping; /file/<name>[?chunked=1][&norange=1][&noauth=1] serves 1,000,000 deterministic bytes (noauth: 403 if an
// Authorization header arrives, i.e. it leaked across a redirect); /redirect?to=<url> answers 302.
import { createServer } from 'node:http'

const SIZE = 1_000_000
const body = Buffer.alloc(SIZE, 0)
for (let i = 0; i < SIZE; i++) body[i] = (i * 31 + 7) & 0xff

createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const auth = req.headers.authorization ? 'auth' : 'no-auth'
  console.log(`${req.headers.host} ${req.method} ${req.url} ${auth}${req.headers.range ? ` range=${req.headers.range}` : ''}`)
  if (url.pathname === '/ping') return res.end('ok')
  if (url.pathname === '/redirect') {
    res.writeHead(302, { Location: url.searchParams.get('to') })
    return res.end()
  }
  if (url.pathname.startsWith('/file/')) {
    if (url.searchParams.get('noauth') && req.headers.authorization) {
      res.writeHead(403)
      return res.end('Authorization leaked across a redirect')
    }
    const range = !url.searchParams.get('norange') && /bytes=(\d+)-/.exec(req.headers.range ?? '')
    const start = range ? Number(range[1]) : 0
    const chunk = body.subarray(start)
    const headers = { 'Content-Type': 'application/octet-stream', ...(url.searchParams.get('norange') ? {} : { 'Accept-Ranges': 'bytes' }) }
    if (!url.searchParams.get('chunked')) headers['Content-Length'] = String(chunk.length)
    if (range) headers['Content-Range'] = `bytes ${start}-${SIZE - 1}/${SIZE}`
    res.writeHead(range ? 206 : 200, headers)
    // Stream in pieces so chunked responses really are chunked.
    for (let i = 0; i < chunk.length; i += 65536) res.write(chunk.subarray(i, i + 65536))
    return res.end()
  }
  res.writeHead(404)
  res.end()
}).listen(8765, '127.0.0.1', () => console.log('test server on :8765'))
