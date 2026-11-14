# 07 构建与运行

## 1. 环境要求

| 用途 | 依赖 | 版本 / 说明 |
| --- | --- | --- |
| 前端开发与构建 | Node.js | 20+（CI 使用 22） |
| 包管理 | npm | 随 Node 安装 |
| 静态检查 | oxlint | 通过 `npm run lint`，随 devDependencies 安装 |
| Android 打包 | JDK | 建议 17（d8 / apksigner 对高版本 JDK 敏感） |
| Android 打包 | Android SDK | `platforms;android-34`、`build-tools;34.0.0` |
| Android 原生库（可选） | NDK | 27.2.12479018，仅实验性本地推理需要 |
| Windows 打包 | .NET Framework `csc.exe` | Windows 10/11 自带 |
| Windows 打包 | Inno Setup 6 | 生成安装包 |
| Serverless 代理（可选） | Cloudflare 账号 | 部署 Worker |

## 2. 依赖与脚本

`package.json`：

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "build:single": "vite build --config vite.single.config.js",
    "lint": "oxlint",
    "preview": "vite preview",
    "preview:single": "vite preview --config vite.single.config.js"
  }
}
```

| 命令 | 产物 | 说明 |
| --- | --- | --- |
| `npm run dev` | 开发服务器 | 默认 `http://localhost:5173`，HMR |
| `npm run build` | `dist/` | 常规静态站点，包含 `data/*.json`、`sw.js` |
| `npm run build:single` | `dist-single/index.html` | 单文件，词库与 favicon 全部内联 |
| `npm run preview` | — | 预览 `dist/` |
| `npm run preview:single` | — | 预览单文件构建 |
| `npm run lint` | — | oxlint 检查 `src` |

运行时依赖：`react`、`react-dom`、`marked`、`dompurify`、`katex`。
开发依赖：`vite`、`@vitejs/plugin-react`、`vite-plugin-singlefile`、`oxlint`、`@types/react*`。

## 3. Vite 配置

### 3.1 常规构建 `vite.config.js`

```js
const base = process.env.PAGES_BASE || '/'

export default defineConfig({
  base,
  plugins: [react()],
})
```

- 本地开发 / 根路径部署：默认 `base = '/'`。
- GitHub Pages 子路径：`PAGES_BASE=./ npm run build`，资源使用相对路径。
- 不配置代理、不注入环境变量，前端请求全部是运行时 URL。

### 3.2 单文件构建 `vite.single.config.js`

三个关键点：

1. `viteSingleFile({ removeViteModuleLoader: true })`：把 JS/CSS 内联进 HTML。
2. 自定义插件 `inlineDictionaryPlugin`：
   - 读取 `public/data/index.json` 与 `dictionary.json`；
   - 把 `<` 转义为 `\u003c`，防止词条内容里的 `</script>` 提前闭合；
   - 把 favicon 转成 base64 data URI；
   - 在 `</body>` 前插入两个 `<script type="application/json" id="...">`。
3. `define` 注入 `VITE_SINGLE_FILE = true`，前端据此跳过 Service Worker 注册。

构建参数：

| 配置 | 值 | 原因 |
| --- | --- | --- |
| `publicDir` | `false` | 避免把未内联的 public 文件重复拷贝 |
| `assetsInlineLimit` | 64 MB | 让字体等资源也内联 |
| `cssCodeSplit` | `false` | 单文件只需要一个 CSS |
| `chunkSizeWarningLimit` | 16,000 KB | 避免 20 MB 级产物刷警告 |
| `outDir` | `dist-single` | 与常规构建隔离 |

> 词库实际大小随版本增长：当前索引约 2.3 MB、完整词库约 15.3 MB，单文件 HTML 约 18–20 MB（未压缩）；插件内注释中的旧数值可以忽略。

## 4. 浏览器 / PWA 运行

```bash
npm install
npm run dev
```

生产部署：

```bash
npm run build
npm run preview     # 本地验证
```

将 `dist/` 部署到任意静态服务器。Service Worker 只在 `location.protocol === 'https:'` 或 `localhost` 下注册，且单文件构建不注册。

### Service Worker 更新

- 缓存名 `wordvault-v3`；修改缓存策略时需要同步 bump 版本号，否则旧缓存不会清理。
- 用户首次访问后，入口页与索引离线可用；完整词库在首次进入学习页后缓存。

## 5. Android 打包

### 5.1 步骤

```bash
npm run build:single
bash android/build-apk.sh
```

输出：`dist-android/WordVault.apk`。

### 5.2 SDK 准备

```bash
sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools"
export ANDROID_SDK_ROOT=/path/to/android-sdk
export JAVA_HOME=/path/to/jdk-17
```

脚本会检查 `aapt2`、`d8`、`zipalign`、`apksigner` 是否存在；缺失时打印安装提示并退出。

### 5.3 签名

- 首次运行会生成 `android/keystore/wordvault.keystore`，别名与口令默认 `wordvault`。
- `.gitignore` 排除了 `android/keystore/`、`*.keystore`、`*.jks`、`*.p12`。
- 覆盖安装要求签名一致：发布版本必须复用同一个 keystore。CI 通过 `WV_KEYSTORE_BASE64` 注入。
- 临时 keystore 只适合本地安装；换机或清理后重新生成的 keystore 会导致「应用未安装 / 签名不一致」。

### 5.4 可选：原生推理库

仅在需要实验性本地 GGUF 时：

```bash
bash android/build-native.sh
```

- 默认 ABI：`arm64-v8a x86_64`，可用 `ABIS` 覆盖。
- 自动拉取固定 commit 的 llama.cpp 到 `android/third_party/llama.cpp`。
- 产物写入 `android/jniLibs/<abi>/libwordvault_llm.so`，随后 `build-apk.sh` 会把它打进 APK。
- 该库体积较大，且前端未接入，默认不要构建。

## 6. Windows 打包

在 Windows 上：

```powershell
npm install
npm run build:single

# 编译启动器（.NET Framework 4.x）
csc /nologo /target:winexe /win32icon:windows\WordVault.ico /out:windows\WordVault.exe windows\launcher.cs

# 生成安装包（Inno Setup 6）
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DMyAppVersion=1.0.0 windows\installer.iss
```

输出：`dist-windows/WordVault-Setup-1.0.0.exe`。

安装包包含 `index.html`、`WordVault.exe`、`WordVault.ico`，不依赖 Node 或网络。

## 7. 一键预览脚本（Windows）

双击 `一键启动预览.bat`：

1. 检查 `package.json`、`node`、`npm`。
2. 首次运行自动 `npm install`。
3. `npm run dev -- --open` 启动并打开浏览器。

`一键启动预览.bat build`：执行 `npm run build:single`，随后用默认浏览器打开 `dist-single/index.html`。

该文件刻意保持纯 ASCII，避免 cmd.exe 在 `chcp` 生效前按 ANSI 代码页解析导致命令损坏。

## 8. Serverless 代理部署

1. Cloudflare Dashboard → Workers & Pages → 创建 Worker。
2. 粘贴 `serverless/kilo-proxy.js` 并部署。
3. 在应用「我的 → AI 引擎」新增或编辑提供方：
   - 地址：`https://<worker>.workers.dev`
   - 模型：`kilo-auto/free`
4. 前端会请求 `<地址>/chat/completions`。

## 9. 词库维护

### 9.1 合并有道词书 `scripts/enrich-dict.mjs`

```bash
node scripts/enrich-dict.mjs [词书 JSON 目录]
```

- 默认目录 `/tmp/books`，文件为 JSONL（一行一个单词）。
- 新增词书：`tem8`、`gre`、`sat`、`gmat`、`tem4`。
- 已有 9,102 个词条完整保留，只新增缺失单词，并把 `bookId` 并入已有词条。
- 裁剪上限：例句 2、搭配 3、同义词组 3、词族组 3。
- 同时重建 `index.json` 与 `dictionary.json`。

### 9.2 补充学习顺序 `scripts/apply-frequency.mjs`

```bash
node scripts/apply-frequency.mjs [词频文件]
```

- 默认读取 `scripts/data/en_50k.txt`（OpenSubtitles 词频，MIT）。
- 只修改 `index.json` 的 `r` 字段，不动词条内容。
- 规则见 [02 · 今日学习队列](./02-state-and-data.md#5-今日学习队列算法)。
- 新增或替换词书后必须重新运行，否则新词没有合理的 `r`。

## 10. CI/CD 发布

### 10.1 自动部署 Pages

push `main` → `deploy.yml`：

```text
npm ci → PAGES_BASE=./ npm run build → upload-pages-artifact → deploy-pages
```

### 10.2 发布三端产物

push `v1.0.0` 标签或手动触发 `release.yml`，输入版本号：

| Job | 产物 |
| --- | --- |
| `apk` | `WordVault-<version>.apk` + `WordVault-<version>-single.html` |
| `windows` | `WordVault-Setup-<version>.exe` |
| `release` | GitHub Release，上传三个文件 |

需要配置的 Secrets：

| Secret | 说明 |
| --- | --- |
| `WV_KEYSTORE_BASE64` | keystore 文件 Base64 |
| `WV_KEYSTORE_PASSWORD` | keystore 口令 |

`APK_VERSION_CODE` 使用 `github.run_number`，保证每次发布递增。

## 11. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `npm run dev` 端口占用 | 5173 被占用 | `npm run dev -- --port 5174` |
| 学习页一直加载词库 | 完整词库 15.3 MB 首次下载慢 / 网络失败 | 用本地 `npm run dev`、单文件版或 APK；检查 Network 面板 |
| 单文件版打不开词库 | 构建后未重新生成 `dist-single` | 重新 `npm run build:single`，确认 HTML 内含两个 JSON script |
| 浏览器 AI 报 CORS | 提供方不允许跨域（如 Kilo） | 用 `serverless/kilo-proxy.js` 代理；Android 会自动走原生桥 |
| AI 401 | Key 缺失或无效 | 「我的 → AI 引擎」填写 Key；DeepSeek 必须填 |
| AI 429 | 免费额度用尽 | 换提供方或稍后再试 |
| AI 400 model_unavailable | llm7 模型下线 | 代码会自动换 `FALLBACK_MODEL`，仍失败则手动改模型名 |
| APK 安装失败「签名不一致」 | 换了 keystore | 卸载旧版，或固定使用同一 keystore |
| `d8` 报 JDK 版本错误 | 使用了过高 JDK | `export JAVA_HOME=/path/to/jdk-17` |
| APK 白屏 | `dist-single` 未生成或 assets 未打入 | 检查 `android/build/assets/index.html` 与 `unzip -l` 产物 |
| Android 收不到提醒 | 通知权限关闭 / 系统省电限制 | 开启通知权限；提醒使用非精确闹钟，可能被系统延后 |
| Windows 启动器打开默认浏览器 | 未安装 Edge/Chrome | 安装任一浏览器，或直接用浏览器打开 `index.html` |
| 导入备份失败 | 文件不是 WordVault 备份 | 确认 JSON 顶层包含 `app: "WordVault"` 与 `data.profile` |
| 上传字体失败 | 扩展名或大小不符 | 仅支持 `.ttf/.otf/.woff/.woff2`，≤ 8 MB |
| 学习记录丢失 | 清理浏览器数据 / localStorage 超限 | 定期导出备份；写入异常会被静默忽略 |
| 页面样式异常 | 旧 Service Worker 缓存 | 强制刷新；必要时 bump `sw.js` 缓存版本 |

## 12. 开发约定

- 提交前运行 `npm run lint`（oxlint 扫描 JS/JSX，Java 源码不在检查范围）。
- `src` 内不要直接操作 localStorage；持久化只发生在 `AppContext.jsx`。
- 新增页面：在 `src/pages` 建组件，在 `src/App.jsx` 的 `Shell` 路由分支注册，必要时加入 `focus` 列表。
- 新增设置项：先加到 `defaultState().settings`，再在 `Profile` 增加 UI 与 `UPDATE_SETTINGS`。
- 新增词书：同时修改 `src/lib/constants.js` 的 `BOOKS` 与 `public/data/dictionary.json` 的 `books`，然后运行 `apply-frequency.mjs`。
- 修改 AI 提示词：只改 `src/lib/llm.js` 的 `build*Messages`，页面无需变动。
- 修改复习算法：只改 `src/lib/sm2.js`，注意 `AppContext` 的 `ANSWER_WORD` 依赖 `reps` / `ease` 推导状态。
