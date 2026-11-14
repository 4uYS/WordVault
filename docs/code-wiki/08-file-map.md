# 08 文件地图

本文按目录列出仓库中每个文件的职责，便于快速定位。构建产物（`dist*`、`node_modules`、`android/build*`、`android/jniLibs`、`android/third_party`、keystore）不纳入版本控制。

## 1. 根目录

| 文件 | 职责 |
| --- | --- |
| `README.md` | 项目介绍、功能、快速开始、打包与数据来源说明 |
| `package.json` | 依赖与 npm 脚本 |
| `package-lock.json` | 依赖锁定 |
| `index.html` | Vite 入口 HTML，挂载 `#root`，加载 `src/main.jsx` |
| `vite.config.js` | 常规构建配置，支持 `PAGES_BASE` |
| `vite.single.config.js` | 单文件构建配置，内联词库与 favicon |
| `.oxlintrc.json` | oxlint 规则：React hooks、只导出组件 |
| `.gitignore` | 忽略构建产物、原生库、keystore、环境变量 |
| `一键启动预览.bat` | Windows 一键启动开发服务器 / 构建单文件版 |
| `serverless/kilo-proxy.js` | Cloudflare Worker CORS 代理（独立目录，见下） |

## 2. `src/` 应用源码

### 2.1 入口与全局

| 文件 | 职责 |
| --- | --- |
| `main.jsx` | `createRoot` 挂载 `<AppProvider><App /></AppProvider>`，注册 Service Worker（非单文件） |
| `App.jsx` | hash 路由、Shell 布局、全局弹层、Toast、UIContext Provider、ReminderWatcher |
| `AppContext.jsx` | 唯一全局 store：state、reducer、持久化、词库加载、派生 stats |
| `UIContext.jsx` | 导航、打开词条、Toast 的 Context |

### 2.2 `src/pages/`

| 文件 | 页面 | 关键职责 |
| --- | --- | --- |
| `Home.jsx` | 今日 | 今日任务、周图表、统计、快捷入口 |
| `Library.jsx` | 词库 | 词书切换、筛选、词条浏览 |
| `SearchPage.jsx` | 查词 | 本地搜索、历史、推荐 |
| `Study.jsx` | 学习 | 每日队列、闪卡、SM-2 评分、计时 |
| `Practice.jsx` | 练习 | 4 种题型、AI 出题、答题统计 |
| `WrongBook.jsx` | 错词本 | 错词筛选与掌握度处理 |
| `AiChat.jsx` | AI | 流式对话、历史持久化、停止生成 |
| `Profile.jsx` | 我的 | 画像、提醒、外观、AI、数据管理 |

### 2.3 `src/components/`

| 文件 | 组件 | 关键职责 |
| --- | --- | --- |
| `Onboarding.jsx` | `Onboarding` | 首次使用 4 步引导 |
| `WordDetail.jsx` | `WordDetail` | 完整词条详情、收藏、掌握度、AI 区块 |
| `SelectionPopup.jsx` | `SelectionPopup` | 页面选词、词形还原、释义浮层 |
| `AiAssistant.jsx` | `AiAssistant` | 词条 AI 例句 / 精讲、结果持久化 |
| `RichText.jsx` | `StreamingText` / `RichMarkdown` | 流式文本、Markdown + KaTeX 渲染 |
| `Icons.jsx` | `Icon` / `LogoMark` | SVG 图标集与品牌标志 |

### 2.4 `src/lib/`

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `dict.js` | 词库加载、查询、搜索 | `loadIndex`、`loadFullDictionary`、`lookupBasic`、`lookupFull`、`searchWords` |
| `sm2.js` | 间隔重复调度 | `QUALITY`、`schedule`、`intervalPreview`、`nextReviewLabel` |
| `llm.js` | AI 请求、SSE、提示词、题目解析 | `generate`、`cancelGeneration`、`build*Messages`、`parseQuiz` |
| `speech.js` | 发音双通道 | `speak`、`stopSpeech` |
| `dectalk.js` | 内嵌 WASM 的 DECtalk 引擎（生成代码） | 默认模块工厂 |
| `native.js` | Android 原生桥接封装 | `isNativeApp`、`scheduleDailyReminder`、`exportBackupNative` |
| `backup.js` | 备份导出与解析 | `downloadBackup`、`parseBackup` |
| `fonts.js` | 自定义字体 IndexedDB | `saveCustomFont`、`applyCustomFont` |
| `date.js` | 日期、周视图、连续打卡 | `todayKey`、`weekDays`、`computeStreak` |
| `richtext.js` | Markdown + LaTeX 安全渲染 | `renderRich` |
| `constants.js` | 词书、目标、水平、AI 提供方等静态配置 | `BOOKS`、`GOALS`、`LEVELS`、`PRACTICE_MODES`、`AI_PROVIDERS` |

### 2.5 样式与静态资源

| 文件 | 职责 |
| --- | --- |
| `styles.css` | 全部页面与组件样式、CSS 变量、深色主题、响应式、动画 |
| `index.css` | 全局重置与根元素尺寸 |
| `App.css` | Vite 模板遗留，**未引用**，可删除 |
| `assets/wordvault-ipa.woff2` | IPA 音标字形子集，`@font-face` 引用 |
| `assets/hero.png` | 模板遗留图片，**未引用** |
| `assets/react.svg` | 模板遗留，**未引用** |
| `assets/vite.svg` | 模板遗留，**未引用** |

## 3. `public/`

| 文件 | 职责 |
| --- | --- |
| `data/index.json` | 轻量索引：单词、音标、首义、词书列表、学习顺序 `r` |
| `data/dictionary.json` | 完整词条：释义、例句、搭配、同反义、词族、词根、词书元数据 |
| `favicon.svg` | 站点图标（单文件构建会转 data URI 内联） |
| `icons.svg` | 额外图标资源，当前未被引用 |
| `sw.js` | PWA Service Worker：预缓存入口与索引，运行时缓存静态资源 |

## 4. `android/`

| 文件 | 职责 |
| --- | --- |
| `AndroidManifest.xml` | Activity、Provider、两个 Receiver、权限声明 |
| `build-apk.sh` | aapt2 → javac → d8 → zip → zipalign → apksigner 全流程 |
| `build-native.sh` | 可选：交叉编译 llama.cpp / JNI 到 `jniLibs` |
| `jni/CMakeLists.txt` | 构建 `libwordvault_llm.so` |
| `jni/llm_jni.cpp` | 实验性本地推理 JNI 实现 |
| `src/com/wordvault/app/MainActivity.java` | WebView 宿主、JS 接口注册、文件选择、返回键 |
| `src/com/wordvault/app/WebBridge.java` | `window.WordVaultNative`：通知、提醒、导出 |
| `src/com/wordvault/app/OnlineLlmBridge.java` | `window.OnlineLlm`：Kilo 网关原生 SSE |
| `src/com/wordvault/app/Reminders.java` | 通知渠道、立即通知、每日 AlarmManager、恢复 |
| `src/com/wordvault/app/ReminderReceiver.java` | 接收每日提醒广播并发通知 |
| `src/com/wordvault/app/BootReceiver.java` | 开机 / 应用升级后恢复提醒 |
| `src/com/wordvault/app/ExportProvider.java` | 只读导出 ContentProvider |
| `src/com/wordvault/app/LlmBridge.java` | 实验性 `window.LlmNative`（未接入） |
| `src/com/wordvault/app/LlmEngine.java` | 实验性 JNI 引擎封装（未接入） |
| `res/values/colors.xml` | 颜色资源 |
| `res/values/strings.xml` | 应用名等字符串 |
| `res/values/styles.xml` | 启动主题 |
| `res/drawable/ic_stat_wordvault.xml` | 通知小图标 |
| `res/mipmap-*/ic_launcher*.png` | 各密度启动图标 |
| `res/mipmap-anydpi-v26/ic_launcher.xml`、`v33` | Android 8 / 13 自适应图标 |

## 5. `windows/`

| 文件 | 职责 |
| --- | --- |
| `launcher.cs` | 查找 Edge/Chrome，以 `--app` 模式打开本地 HTML |
| `installer.iss` | Inno Setup 安装包脚本 |
| `WordVault.ico` | 启动器与安装包图标 |

## 6. `serverless/`

| 文件 | 职责 |
| --- | --- |
| `kilo-proxy.js` | Cloudflare Worker：转发 Kilo 网关请求并补充 CORS 头，支持 SSE 流式 |

## 7. `scripts/`

| 文件 | 职责 |
| --- | --- |
| `enrich-dict.mjs` | 合并有道词书 JSONL，重建索引与完整词库 |
| `apply-frequency.mjs` | 用词频表给索引补充 `r` 学习顺序 |
| `data/en_50k.txt` | OpenSubtitles 英文词频表（MIT），仅使用词序 |

## 8. `.github/workflows/`

| 文件 | 职责 |
| --- | --- |
| `deploy.yml` | push `main` 构建并部署 GitHub Pages |
| `release.yml` | 标签/手动触发，构建 APK、Windows 安装包、单文件 HTML 并发布 Release |

## 9. `docs/code-wiki/`

| 文件 | 内容 |
| --- | --- |
| `README.md` | Wiki 索引与项目速览 |
| `01-architecture.md` | 分层架构、启动流程、路由、跨平台形态、依赖关系 |
| `02-state-and-data.md` | 状态结构、reducer、SM-2、队列算法、词库格式、存储 |
| `03-pages.md` | 8 个页面详解 |
| `04-components.md` | 组件与样式体系 |
| `05-lib.md` | 核心库逐模块说明 |
| `06-platforms.md` | Android / Windows / Serverless / SW / CI |
| `07-build-and-run.md` | 环境、构建、打包、维护脚本、排障 |
| `08-file-map.md` | 本文件 |

## 10. 需要留意的遗留 / 实验代码

| 路径 | 状态 | 建议 |
| --- | --- | --- |
| `src/App.css` | 未引用 | 确认后删除 |
| `src/assets/hero.png`、`react.svg`、`vite.svg` | 未引用 | 确认后删除 |
| `public/icons.svg` | 未引用 | 确认后删除 |
| `android/jni/*`、`LlmBridge.java`、`LlmEngine.java`、`build-native.sh` | 实验性，前端未接入 | 若长期不推进，可移到独立分支或目录 |
| `src/lib/dict.js` 的 `useDictionaryPrefetch` | 未被页面使用（真实预取在 `AppContext`） | 可删除或改由页面使用 |
| `src/AppContext.jsx` 的 `stateRef` | 当前未使用 | 可删除 |
