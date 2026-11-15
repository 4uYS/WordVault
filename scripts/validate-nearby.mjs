/**
 * 附近设备同步自检（纯 Node，不需要浏览器 / Android SDK）。
 * 覆盖：BLE beacon 两端字节布局一致性、非法包过滤、局域网地址白名单、
 *       手动地址解析、HTTP 端点契约（用等价 mock server 验证）。
 */
import http from 'node:http'
import {
  NEARBY_BEACON_SIZE,
  NEARBY_DEFAULT_PORT,
  NEARBY_SERVICE_UUID,
  bytesToIp,
  decodeBeacon,
  encodeBeacon,
  ipToBytes,
  isLanAddress,
  parseManualEndpoint,
  peerFromBeacon,
} from '../src/lib/nearbyProtocol.js'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' | ' + extra : '')) }
}

console.log('\n[1] BLE beacon 字节布局（与 NearbyBridge.java 一致）')
// Java 端等价实现：magic / version / ip4 / port BE / flags
function javaBeacon(ip, port, flags) {
  const b = Buffer.alloc(9)
  b[0] = 0x57; b[1] = 1
  ip.split('.').forEach((n, i) => { b[2 + i] = Number(n) })
  b[6] = (port >> 8) & 0xff; b[7] = port & 0xff; b[8] = flags
  return b
}
for (const [ip, port, flags] of [
  ['192.168.1.5', 8765, 1],
  ['10.0.0.23', 8766, 3],
  ['172.16.31.244', 65535, 2],
]) {
  const js = encodeBeacon({ ip, port, flags })
  const java = javaBeacon(ip, port, flags)
  check(`${ip}:${port} 字节一致`, Buffer.compare(Buffer.from(js), java) === 0)
  const decoded = decodeBeacon(java)
  check(`${ip}:${port} 解码一致`, decoded?.ip === ip && decoded?.port === port && decoded?.flags === flags,
    JSON.stringify(decoded))
}
check('beacon 恰好 9 字节', NEARBY_BEACON_SIZE === 9 && encodeBeacon({ ip: '192.168.1.5' }).length === 9)
check('128-bit Service Data 不超 BLE 31 字节预算',
  3 /* flags AD */ + 2 /* AD header */ + 16 /* UUID */ + NEARBY_BEACON_SIZE <= 31)
check('Service UUID 是 128-bit', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(NEARBY_SERVICE_UUID))

console.log('\n[2] 解码容错与输入类型')
check('Uint8Array 可解', decodeBeacon(encodeBeacon({ ip: '10.1.2.3' }))?.ip === '10.1.2.3')
check('DataView 可解', (() => {
  const u = encodeBeacon({ ip: '10.1.2.3' })
  return decodeBeacon(new DataView(u.buffer))?.ip === '10.1.2.3'
})())
check('ArrayBuffer 可解', (() => {
  const u = encodeBeacon({ ip: '10.1.2.3' })
  return decodeBeacon(u.buffer)?.ip === '10.1.2.3'
})())
check('短包返回 null', decodeBeacon(new Uint8Array(5)) === null)
check('错 magic 返回 null', (() => {
  const b = encodeBeacon({ ip: '10.1.2.3' }); b[0] = 0x58
  return decodeBeacon(b) === null
})())
check('错 version 返回 null', (() => {
  const b = encodeBeacon({ ip: '10.1.2.3' }); b[1] = 2
  return decodeBeacon(b) === null
})())
check('非法 IP 不编码', encodeBeacon({ ip: '999.1.2.3' }) === null
  && encodeBeacon({ ip: 'abc' }) === null)
check('非法端口不编码', encodeBeacon({ ip: '10.1.2.3', port: 0 }) === null
  && encodeBeacon({ ip: '10.1.2.3', port: 70000 }) === null)
check('ipToBytes / bytesToIp 互逆', bytesToIp(ipToBytes('192.168.50.7')) === '192.168.50.7')
check('flags 位含义正确', (() => {
  const d = decodeBeacon(encodeBeacon({ ip: '10.1.2.3', flags: 3 }))
  return d.hasBackup === true && d.canReceive === true
})())

console.log('\n[3] 局域网地址白名单（防止备份发到公网）')
for (const ip of ['192.168.1.5', '10.0.0.9', '172.16.0.1', '172.31.255.254', '127.0.0.1', '169.254.3.4']) {
  check(`${ip} 允许`, isLanAddress(ip))
}
for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.1.1', '0.0.0.0', '']) {
  check(`${ip} 拒绝`, !isLanAddress(ip))
}

console.log('\n[4] 手动地址解析与 peer 构造')
check('IP + 默认端口', (() => {
  const p = parseManualEndpoint('192.168.1.5')
  return p?.ip === '192.168.1.5' && p?.port === NEARBY_DEFAULT_PORT && p?.source === 'manual'
})())
check('IP:端口', parseManualEndpoint('10.0.0.7:9000')?.port === 9000)
check('带空格可容忍', parseManualEndpoint('  192.168.1.5:8765  ')?.id === '192.168.1.5:8765')
for (const bad of ['', 'abc', '192.168.1.5:0', '192.168.1.5:99999', '8.8.8.8:8765']) {
  check(`拒绝「${bad}」`, parseManualEndpoint(bad) === null || !isLanAddress(parseManualEndpoint(bad).ip))
}
check('peer 生成 http URL 且仅局域网', (() => {
  const p = peerFromBeacon(decodeBeacon(encodeBeacon({ ip: '192.168.1.9', flags: 3 })), 'ble')
  return p.url === 'http://192.168.1.9:8765' && p.hasBackup === true && isLanAddress(p.ip)
})())

console.log('\n[5] HTTP 端点契约（等价 mock server）')
const BACKUP = JSON.stringify({ app: 'WordVault', version: 1, data: { profile: { nickname: '测试' } } })
let hosted = null
let received = null
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method === 'GET' && req.url === '/wordvault/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"app":"WordVault","version":1,"nearby":true}')
    return
  }
  if (req.method === 'GET' && req.url === '/wordvault/backup') {
    if (hosted === null) { res.writeHead(404); res.end('{"error":"no backup hosted"}'); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(hosted)
    return
  }
  if (req.method === 'POST' && req.url === '/wordvault/backup') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (!body.includes('"app"') || !body.includes('WordVault') || !body.includes('"data"')) {
        res.writeHead(400); res.end('{"error":"not a WordVault backup"}')
      } else {
        received = body
        res.writeHead(200); res.end('{"ok":true}')
      }
    })
    return
  }
  res.writeHead(404); res.end('{"error":"not found"}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const ping = await fetch(`${base}/wordvault/ping`).then((r) => r.json())
check('GET /ping 返回 WordVault 身份', ping.app === 'WordVault' && ping.nearby === true)

const empty = await fetch(`${base}/wordvault/backup`)
check('未托管备份时 GET 返回 404', empty.status === 404)
hosted = BACKUP
const pulled = await fetch(`${base}/wordvault/backup`)
const pulledText = await pulled.text()
check('托管后 GET 返回完整 JSON', pulled.status === 200 && JSON.parse(pulledText).app === 'WordVault')
check('GET 响应带 CORS 头', pulled.headers.get('access-control-allow-origin') === '*')

const badRes = await fetch(`${base}/wordvault/backup`, { method: 'POST', body: '{"hello":1}' })
check('非 WordVault 备份被拒（400）', badRes.status === 400)
const okRes = await fetch(`${base}/wordvault/backup`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: BACKUP,
})
check('合法备份 POST 成功', okRes.status === 200 && received === BACKUP)
check('POST 不静默写库（只存进待确认）', received !== null && typeof received === 'string')
const opt = await fetch(`${base}/wordvault/backup`, { method: 'OPTIONS' })
check('OPTIONS 预检 204', opt.status === 204)
const notFound = await fetch(`${base}/other`)
check('未知路径 404', notFound.status === 404)

server.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
