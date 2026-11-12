/**
 * Kilo Gateway CORS 代理（Cloudflare Worker）。
 *
 * 部署：Cloudflare Dashboard → Workers & Pages → 创建 Worker → 粘贴本文件 → 部署。
 * 然后把 Worker 域名（如 https://kilo-proxy.your-name.workers.dev）填到
 * 应用「我的 → 在线 AI → 代理地址」即可，前端会请求 <代理域名>/chat/completions。
 */
const UPSTREAM = 'https://ai-gateway.kilo.ai/api/v1'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS })
    }

    const url = new URL(request.url)
    const headers = new Headers(request.headers)
    headers.delete('host')
    headers.delete('origin')
    headers.delete('referer')
    headers.delete('cf-connecting-ip')

    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: 'POST',
      headers,
      body: request.body,
    })

    const responseHeaders = new Headers(upstream.headers)
    for (const [key, value] of Object.entries(CORS)) responseHeaders.set(key, value)
    responseHeaders.delete('content-encoding')
    responseHeaders.delete('content-length')

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    })
  },
}
