# WordVault · 词库宝箱

本地优先、离线可用的英语单词学习应用。前端为 React + Vite，词库随应用分发，学习数据只保存在设备本地；可构建成单个 HTML 文件，或套一层 Android WebView 壳打包成 APK。

## 功能

- **离线词库**：内置 CET-4/6、考研、雅思、托福、高考、专四/专八、GRE、SAT、GMAT 共 11 本词书，约 18000 词条，查词与练习全程不发请求。
- **SM-2 复习调度**：按「忘记 / 模糊 / 记得 / 熟练」评分自动安排下次复习，答错 10 分钟后重来。
- **今日学习**：到期复习 + 每日新词上限；新词按语料词频由高到低出现，复习量可设每日上限，超出的到期词顺延次日。
- **专项练习**：看英选中、听音辨词、拼写测试、选词填空，四种模式本地出题；答错自动进错词本。
- **AI 助手**：AI 例句、精讲、出题与自由问答，支持任意 OpenAI 兼容服务（内置 llm7.io 免 Key）；生成的对话与例句/解析会持久化到本机。
- **选词查词**：在页面任意位置选中英文单词即可弹出本地释义，支持常见词形还原（复数、时态、比较级等）。
- **发音**：优先 Web Speech API，失败时自动降级到内嵌 WASM 的 DECtalk。
- **本地数据**：学习记录、设置、AI 缓存均在 localStorage；支持 JSON 备份导出/导入。
- **主题与字体**：浅色 / 深色 / 跟随系统，可上传本地字体（仅存 IndexedDB）。

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

产物为 `dist-single/index.html`（约 10 MB）：Vite 把 JS/CSS 内联，构建插件再把词库 JSON 与 favicon 一并内联，因此完全离线、单文件即可运行。该模式不注册 Service Worker。

## Android 打包

`android/` 下是无 Gradle 的脚本化打包流程：

```bash
npm run build:single
bash android/build-apk.sh
```

依赖 Android SDK build-tools 34、platform 34 与 JDK 17；`ABIS` 可指定 ABI（默认 `arm64-v8a,x86_64`）。脚本会用 `aapt2 → javac → d8 → zipalign → apksigner` 生成 `dist-android/WordVault.apk`。

签名文件与口令不随仓库分发：`.gitignore` 已排除 `android/keystore/`，首次打包会提示自行生成。

> `android/jni/llm_jni.cpp` 与 `LlmBridge.java` 是早期本地 GGUF 推理的实验代码，当前版本前端未接入，默认不参与构建。`android/build-native.sh` 需要自行拉取 llama.cpp 才能编译。

## 目录结构

```
src/
  App.jsx            # hash 路由、全局弹层
  AppContext.jsx     # 唯一 store：状态、持久化、派生统计
  pages/             # 今日 / 词库 / 查词 / 学习 / 练习 / 错词本 / AI / 我的
  components/        # 词条详情、选词弹层、AI 助手、富文本、引导页
  lib/
    dict.js          # 词库加载与本地搜索
    sm2.js           # 间隔重复调度
    llm.js           # 在线 AI（SSE 流式）
    speech.js        # Web Speech + DECtalk 兜底
    fonts.js backup.js date.js richtext.js constants.js
public/
  data/index.json        # 轻量索引（词、音标、首义、所属词书、词频顺序 r）
  data/dictionary.json   # 完整词条（释义、例句、搭配、同反义、词根等）
  sw.js                  # PWA 缓存
android/                 # WebView 壳与打包脚本
serverless/kilo-proxy.js # Kilo 网关 CORS 代理（Cloudflare Worker）
scripts/
  enrich-dict.mjs        # 合并有道词书并重建索引
  apply-frequency.mjs    # 用 scripts/data 的词频表给索引补充学习顺序
  data/en_50k.txt        # 词频表（OpenSubtitles 语料，MIT）
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

API Key 与所有配置一样只保存在本机 localStorage，导出备份时会一并写入 JSON，请自行妥善保管备份文件。

## 数据来源与隐私

- 词库整理自开源项目 [kajweb/dict](https://github.com/kajweb/dict)（有道词书数据），经裁剪合并后随应用离线分发。
- 学习顺序使用的词频表来自 [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords)（MIT，基于 OpenSubtitles 2018 语料），仅使用其中的英文词序。
- 用户数据不上传任何服务器；应用没有账号体系，也不接入第三方统计。
- 在线 AI 只会在用户主动点击生成时发出请求，请求内容为当前词条与提示词。

## License

代码以仓库内约定为准；词库数据版权归原始来源所有，仅供学习研究使用。
