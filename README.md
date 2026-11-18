# WordVault · 词库宝箱

本地优先、离线可用的英语单词学习应用。前端为 React + Vite，词库随应用分发，学习数据只保存在设备本地；可构建成单个 HTML 文件，或套一层 Android WebView 壳打包成 APK，或用 Inno Setup 打成 Windows 安装包。

在线演示：<https://4uys.github.io/WordVault/>（GitHub Pages，推送 `main` 自动部署）

> 词库约 15 MB，首次进入学习页需要下载完整词条。网络较慢时建议使用本地构建或 APK。

## 功能

- **离线词库**：内置 CET-4/6、考研、雅思、托福、高考、专四/专八、GRE、SAT、GMAT 共 11 本词书，约 18000 词条，查词与练习全程不发请求。
- **SM-2 复习调度**：按「忘记 / 模糊 / 记得 / 熟练」评分自动安排下次复习，答错 10 分钟后重来。
- **今日学习**：到期复习 + 每日新词上限；新词按语料词频由高到低出现，复习量可设每日上限，超出的到期词顺延次日。
- **专项练习**：看英选中、听音辨词、拼写测试、选词填空，四种模式本地出题；答错自动进错词本。
- **AI 助手**：AI 例句、精讲、出题与自由问答，支持任意 OpenAI 兼容服务（内置 llm7.io 免 Key）；生成的对话与例句/解析会持久化到本机。
- **AI Agent 工具**：对话里可调用 44 个本机工具（查词、统计、错词本、改昵称、切词书、朗读、补录词条……），只读自动执行、写操作先弹确认卡片；多步过程用平铺的「已完成思考」卡片展示，可展开回看。API Key 不会进入提示词上下文。
- **选词查词**：在页面任意位置选中英文单词即可弹出本地释义，支持常见词形还原（复数、时态、比较级等）。
- **发音**：优先 Web Speech API，失败时自动降级到内嵌 WASM 的 DECtalk；支持美音 / 英音与语速调节，长文本自动分片朗读。
- **本地数据**：学习记录、设置、AI 缓存均在 localStorage；支持 JSON 备份导出/导入。
- **附近设备传输**：蓝牙发现附近设备，学习备份走同一 Wi-Fi 直连收发，不经过外部服务器；接收端必须手动确认才写入。文件导入/导出保留作兜底。
- **主题与字体**：浅色 / 深色 / 跟随系统，可上传本地字体（仅存 IndexedDB）。

## 界面外观

v1.0.6 起为**纯白灰阶 + 圆角 + 统一图标系统**：主色由品牌蓝改为墨黑，页面与卡片纯白，靠淡边框和柔阴影分层；按钮是胶囊圆角，面板 16px、弹层与 AI 输入条 24px、Toast 12px。

图标收进 `index.html` 内联的 91 枚 SVG sprite（24×24 / 1.75 描边 / round / `currentColor`），`Icons.jsx` 公共 API 不变，深浅主题自动适配。形状规范来自组件 Kit `wv-ui.css`，采用「适配层桥接」方式接入，**没有重写现有组件结构**，94 项端到端回归全部保持通过。

细节与后续迁移建议见 [UI_KIT.md](UI_KIT.md)。

## 快速开始

需要 Node.js 20+。

```bash
npm install
npm run dev        # 开发预览，默认 http://localhost:5173
npm run lint       # oxlint
npm run build      # 常规构建（含 Service Worker）
npm run preview
```

Windows 下也可以直接双击 `一键启动预览.bat`：自动检查 Node、首次安装依赖并启动预览；`一键启动预览.bat build` 则构建单文件版并直接打开。

## 单文件构建

```bash
npm run build:single
```

产物为 `dist-single/index.html`（约 21 MB）：Vite 把 JS/CSS 内联，构建插件再把词库 JSON、字体与 favicon 一并内联（字体 base64 会膨胀约 1/3），因此完全离线、单文件即可运行。该模式不注册 Service Worker。

**为什么 APK / EXE 只有约 7 MB**：单文件 HTML 是未压缩的纯文本，浏览器双击直读；APK 是 ZIP 归档、Windows 安装包用 LZMA，重复的 JSON 字段名压缩率极高，体积约为原始的 1/3。压缩过的 HTML 无法被 `file://` 直接打开，所以单文件版保留原始体积换零依赖。

## Android 打包

`android/` 下是无 Gradle 的脚本化打包流程：

```bash
npm run build:single
bash android/build-apk.sh
```

依赖 Android SDK build-tools 34、platform 34 与 JDK 17；`ABIS` 可指定 ABI（默认 `arm64-v8a,x86_64`）。脚本会用 `aapt2 → javac → d8 → zipalign → apksigner` 生成 `dist-android/WordVault.apk`。

签名文件与口令不随仓库分发：`.gitignore` 已排除 `android/keystore/` 与 `*.keystore`。CI 打包必须注入固定密钥（见「安装与升级」）；本地未配置时会生成一次性 debug keystore 并醒目提示不可用于发布。

单文件 APK 里 WebView 不支持 `<a download>` 和 Notification API，因此提供了一组原生桥接：

| 能力 | 桥接方法 | 说明 |
| --- | --- | --- |
| 导出学习记录 | `exportBackup(filename, json)` | 写入缓存目录后调起系统分享面板，可存到文件、网盘或发给自己 |
| 即时通知 | `notifyNow(title, body)` | 走 Android 通知渠道 |
| 每日定时提醒 | `scheduleDailyReminder(hhmm, title, body)` | AlarmManager 每日触发，**关闭应用也能收到**；开机/更新后自动恢复 |
| 通知权限 | `notificationStatus()` / `requestNotificationPermission()` | Android 13+ 的 POST_NOTIFICATIONS 授权 |
| 附近设备 | `nearbyStart()` / `nearbyStop()` | BLE 广播+扫描，并开启局域网 HTTP 服务；仅扫描期间有效 |
| 本机端点 | `nearbyEndpoint()` | 返回 `IP:端口`，写进 BLE 广播 |
| 托管备份 | `nearbySetBackup(json)` | 供对端 `GET /wordvault/backup` 拉取 |
| 收到备份 | `wordvault:nearby-received` 事件 | 前端弹确认卡片后才写入，不静默覆盖 |

前端封装在 `src/lib/native.js` 与 `src/lib/nearby.js`，浏览器与 `file://` 单文件环境自动降级到 Web Bluetooth 或手动输入地址。协议细节见 [NEARBY_SYNC.md](NEARBY_SYNC.md)。

## Windows 安装包

`windows/` 下是轻量安装包方案：安装单文件 HTML + 一个启动器（用 Edge/Chrome 的 `--app` 窗口模式打开，找不到时退回默认浏览器），由 Inno Setup 打包成 `WordVault-Setup-x.y.z.exe`。

```powershell
csc /target:winexe /win32icon:windows\WordVault.ico /out:windows\WordVault.exe windows\launcher.cs
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DMyAppVersion=1.0.0 windows\installer.iss
```

## 安装与升级（APK 签名）

Android 覆盖安装要求**包名 + 签名证书**都与已装版本一致，否则会提示「无法自动更新，因为与旧的 APK 签名不相符」。

v1.0.0–v1.0.4 在 CI 上每次自动生成临时 keystore，导致每个版本签名都不同。**从 v1.0.5 起改为固定 release 密钥**，之后所有版本可直接覆盖安装、数据保留。

| 当前手机上的版本 | 升级到 v1.0.5+ |
| --- | --- |
| v1.0.4 或更早 | **先卸载旧版**（旧证书无法找回），装新版后再导入备份 |
| v1.0.5 及以后 | 直接覆盖安装，无需卸载 |

卸载前请先在「我的 → 本地数据」导出 JSON 备份，或用「附近设备传输」转到另一台设备，装完再导入。

发布证书 SHA-256（公开值，非敏感）：

```
8aa4cd2a121a56f98ca82722f72380e414e539ffd9f8d9cb76f31fd99831ada9
```

维护细节见 [ANDROID_SIGNING.md](ANDROID_SIGNING.md)。

## 自动发布（GitHub Actions）

`.github/workflows/release.yml` 在手动触发或推送 `v*` 标签时：

1. Ubuntu 任务：安装 Android SDK，构建单文件 HTML，校验签名 Secret 齐全后打包并对证书指纹做断言；
2. Windows 任务：编译启动器，Inno Setup 生成安装包；
3. 汇总 APK、Windows 安装包与单文件 HTML，创建 GitHub Release 并上传三个资产。

签名（v1.0.5 起固定，不再随机生成）：

- `WV_KEYSTORE_BASE64`：固定 keystore 的 Base64（**必需**）；
- `WV_KEYSTORE_PASSWORD`：对应口令（**必需**）；
- `WV_EXPECTED_CERT_SHA256`：公开证书指纹，写在 `release.yml` 里做断言。

三层防漂移：先校验 secret 齐全 → CI 缺密钥直接 fail fast，绝不产随机签名包 → 打包后用 `apksigner verify --print-certs` 比对实际指纹，不符即中止发布。指纹同时写进 job summary，每次 Release 可核对。

> ⚠️ keystore 与口令请自行离线备份。一旦丢失，旧用户将无法再覆盖升级，只能卸载重装。

> `android/jni/llm_jni.cpp` 与 `LlmBridge.java` 是早期本地 GGUF 推理的实验代码，当前版本前端未接入，默认不参与构建。`android/build-native.sh` 需要自行拉取 llama.cpp 才能编译。

## 目录结构

```
src/
  App.jsx            # hash 路由、全局弹层
  AppContext.jsx     # 唯一 store：状态、持久化、派生统计
  pages/             # 今日 / 词库 / 查词 / 学习 / 练习 / 错词本 / AI / 我的
    NearbyPanel.jsx  # 附近设备传输面板
  components/        # 词条详情、选词弹层、AI 助手、富文本、引导页
    Icons.jsx        # 统一图标组件（sprite use，公共 API 不变）
  wv-ui.css          # 组件 Kit + 纯白覆盖层 + 图标规范 + 深色桥接
  styles.css         # 全局样式，末尾为「纯白 + 圆角」适配层
  index.css          # 基础重置与圆角 token
  lib/
    dict.js          # 词库加载与本地搜索
    sm2.js           # 间隔重复调度
    llm.js           # 在线 AI（SSE 流式）+ Agent 提示词与 JSON 指令解析
    agentTools.js    # 44 个本机工具注册表、校验与执行器
    nearbyProtocol.js # BLE beacon 编解码、局域网地址白名单（纯函数）
    nearby.js        # 蓝牙发现适配 + 局域网备份收发
    backup.js        # 备份序列化 / 解析（文件与直连共用格式）
    speech.js        # Web Speech + DECtalk 兜底
    native.js        # Android WebView 原生桥接（导出 / 通知 / 附近设备）
    fonts.js date.js richtext.js constants.js
public/
  data/index.json        # 轻量索引（词、音标、首义、所属词书、词频顺序 r）
  data/dictionary.json   # 完整词条（释义、例句、搭配、同反义、词根等）
  sw.js                  # PWA 缓存
android/                 # WebView 壳、原生桥接与打包脚本
  src/.../NearbyBridge.java # BLE 广播/扫描 + 局域网 HTTP 服务
windows/                 # 启动器 + Inno Setup 安装包脚本
serverless/kilo-proxy.js # Kilo 网关 CORS 代理（Cloudflare Worker）
scripts/
  enrich-dict.mjs        # 合并有道词书并重建索引
  apply-frequency.mjs    # 用 scripts/data 的词频表给索引补充学习顺序
  validate-agent.mjs     # AI Agent 提示词与工具协议自检
  validate-nearby.mjs    # BLE beacon / 局域网 HTTP 契约自检
  data/en_50k.txt        # 词频表（OpenSubtitles 语料，MIT）
AI_AGENT_CHANGES.md      # AI Agent 改造与历次 UI / 布局修复记录
UI_KIT.md                # 纯白 + 圆角 + 统一图标系统的接入说明
NEARBY_SYNC.md           # 附近设备同步协议与平台能力说明
ANDROID_SIGNING.md       # APK 固定签名与证书轮换说明
```

## 学习顺序

新词按语料词频由高到低进入队列，而不是字母序：

- 基础虚词与语气词（the / and / oh / okay 等）统一后置，不占学习队列前排。
- 词频表未收录的进阶词按词书原始顺序兜底，避免尾部退回字母序。
- 修改词书或词频表后运行 `node scripts/apply-frequency.mjs` 重新生成索引中的 `r` 字段。

「我的 → 学习画像 → 每日复习上限」控制每天最多安排多少到期复习词，超出部分自动顺延到次日。

## AI 配置

「我的 → AI 引擎」可切换或新增 OpenAI 兼容服务。内置：

| 提供方 | 说明 |
| --- | --- |
| llm7.io | 免费、免 Key、允许浏览器跨域，默认项 |
| DeepSeek | 需填写 API Key |
| Kilo AutoFree | 浏览器需代理；Android 内走原生 HTTP 桥接 |

API Key 与所有配置一样只保存在本机 localStorage，导出备份时会一并写入 JSON，请自行妥善保管备份文件；AI 对话的上下文注入会主动排除 Key，不会随提示词外发。

对话里除了问答，还能让 AI 直接操作本机：查词、查学习统计、改昵称、切词书、朗读、把查不到的词补录进词书等。只读工具自动执行，写操作会先弹确认卡片；多步过程以平铺思考卡片展示。工具清单与改造记录见 [AI_AGENT_CHANGES.md](AI_AGENT_CHANGES.md)。

## 数据来源与隐私

- 词库整理自开源项目 [kajweb/dict](https://github.com/kajweb/dict)（有道词书数据），经裁剪合并后随应用离线分发。
- 学习顺序使用的词频表来自 [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords)（MIT，基于 OpenSubtitles 2018 语料），仅使用其中的英文词序。
- 用户数据不上传任何服务器；应用没有账号体系，也不接入第三方统计。「附近设备传输」是同一 Wi-Fi 内两台设备点对点直连，地址白名单只放行局域网网段，公网地址一律拒绝。
- 在线 AI 只会在用户主动点击生成时发出请求，请求内容为当前词条与提示词。

## License

代码以仓库内约定为准；词库数据版权归原始来源所有，仅供学习研究使用。
