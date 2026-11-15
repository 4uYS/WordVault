# 附近设备传输：蓝牙发现 + 局域网直连

把「导出 JSON 文件 → 手动传 → 导入」换成**设备间直连传输**。原来的文件导入/导出**完整保留**作兜底。

入口：`我的 → 本地数据 → 附近设备传输`。

## 为什么分两段

| 阶段 | 技术 | 传什么 |
|---|---|---|
| 发现 | BLE 广播（Service Data） | 9 字节 beacon：本机局域网 IP + HTTP 端口 |
| 传输 | 局域网 HTTP | 完整备份 JSON（GET 拉取 / POST 推送） |

BLE 实际吞吐只有 20–40 KB/s，几 MB 的词库备份走蓝牙要几分钟；而局域网是几十 MB/s。所以蓝牙**只用来知道对方在哪**，数据一律走 Wi-Fi 直连，全程不经任何外部服务器。

## Beacon 字节布局（9 字节）

BLE 广播包上限 31 字节：Flags AD(3) + AD 头(2) + 128-bit Service UUID(16) = 21，Service Data 最多再放 10 字节。用 9 字节留 1 字节余量。

```
偏移  长度  含义
0     1     magic 0x57 ('W')
1     1     version = 1
2-5   4     IPv4，逐字节
6-7   2     port，uint16 大端
8     1     flags：bit0 可接收 / bit1 已托管备份
```

- Service UUID：`0000fa57-0000-1000-8000-00805f9b34fb`
- 前端实现：`src/lib/nearbyProtocol.js` 的 `encodeBeacon` / `decodeBeacon`
- Android 实现：`NearbyBridge.beacon()`，字节序完全一致（自检脚本做了交叉验证）
- 广播里**不额外放 Service UUID 字段**，只放 Service Data，否则会顶爆 31 字节；因此扫描端不设 service filter，扫到后按 magic 过滤

## 局域网 HTTP 端点

仅扫描期间在 `0.0.0.0:8765`（被占用则顺延到 8784）开启，停止扫描即关闭。

| 方法 | 路径 | 行为 |
|---|---|---|
| `GET` | `/wordvault/ping` | 返回 `{"app":"WordVault",...}`，用于连通性与身份确认 |
| `GET` | `/wordvault/backup` | 拉取本机托管的备份；未托管返回 404 |
| `POST` | `/wordvault/backup` | 接收对端备份，交给前端弹确认，**绝不静默写库** |
| `OPTIONS` | `*` | 204 + CORS 预检（WebView 的 `file://` origin 是 `null`） |

所有响应带 `Access-Control-Allow-Origin: *`。POST 用 base64 把 JSON 传给 WebView，避免中文与引号破坏 `evaluateJavascript` 字符串。

## 平台能力

| 平台 | 蓝牙发现 | 被别的设备发现 | 收 / 发 |
|---|---|---|---|
| Android APK | 原生 BLE 扫描 | 原生 BLE 广播 + HTTP 服务 | ✅ / ✅ |
| 桌面 Chrome / Edge | Web Bluetooth `requestLEScan` | 浏览器不能 BLE 广播 | ✅ 向 Android 拉 / 推 |
| 其它浏览器 | 无 | 无 | ✅ 手动输入对方 `IP:端口` |
| iOS Safari | 不支持 Web Bluetooth | 不支持 | ✅ 手动输入或回退文件备份 |

Android ↔ Android、Android ↔ 桌面都能完整闭环。桌面 ↔ 桌面时至少一端需要有 HTTP 服务（Android）；两台纯桌面浏览器请使用文件导入导出，或在面板里手动填 Android 显示的地址。

**两台设备必须连同一个 Wi-Fi**。地址白名单只允许 `10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`127/8`，公网地址一律拒绝，防止误把学习记录发到外网。

## 安全边界

- 接收端永远要用户点一次「确认导入」才会覆盖本机数据；推送端也先本地校验备份格式
- 服务端只绑定扫描期间，退出页面 / 停止扫描即 `ServerSocket.close()`
- Android 页面在 `file://` 下，需要 `MIXED_CONTENT_ALWAYS_ALLOW` + `usesCleartextTraffic="true"` 才能 fetch 局域网 `http://`
- 蓝牙权限：Android 12+ 用 `BLUETOOTH_ADVERTISE/SCAN/CONNECT`，旧版回落 `ACCESS_FINE_LOCATION`；拒绝权限后仍可手动填地址

## 改动清单

**新增**
- `src/lib/nearbyProtocol.js` — 纯协议层（无浏览器依赖，Node 可自检）
- `src/lib/nearby.js` — 平台适配：原生桥接 / Web Bluetooth / 降级、HTTP 收发
- `src/pages/NearbyPanel.jsx` — 面板 UI（复用项目内置样式）
- `android/src/com/wordvault/app/NearbyBridge.java` — BLE 广播/扫描 + ServerSocket HTTP
- `scripts/validate-nearby.mjs` — 49 项协议自检

**修改**
- `src/lib/backup.js` — 抽出 `serializeBackup()`，文件与直连共用同一格式
- `src/lib/native.js` — 4 个新桥接方法
- `src/pages/Profile.jsx` — 数据页加入口 + `nearby` 详情
- `src/styles.css` — 仅新增 `.nearby-ip-input`
- `android/src/.../WebBridge.java` — 转发 JS 接口、权限回调、生命周期
- `android/src/.../MainActivity.java` — 允许 file 页访问局域网明文 HTTP
- `android/AndroidManifest.xml` — 蓝牙权限 + `usesCleartextTraffic`

## 验证

- `node scripts/validate-nearby.mjs`：49/49（beacon 两端字节一致、非法包过滤、地址白名单、HTTP 契约）
- `node scripts/validate-agent.mjs`：65/65（原有 AI Agent 回归）
- `npm run lint`：0 error
- `e2e_check.py`：99 + 新增面板用例（mock 原生桥接 + mock 局域网端点）

> 注：Android 原生 Java 部分由 CI 的 `apk` job 用 `android-34` / JDK 17 编译，沙盒内无 Android SDK，未做本地编译。真机蓝牙与局域网收发需在两台设备上实测。
