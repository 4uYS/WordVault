# WordVault Code Wiki

WordVault（词库宝箱）是一个**本地优先、离线可用**的英语单词学习应用。前端采用 React 19 + Vite，词库随应用分发；学习记录、设置与 AI 缓存全部保存在设备本地。项目同时提供浏览器、单文件 HTML、Android WebView APK、Windows 安装包四种交付形态。

本目录是面向开发者的 Code Wiki，目标是把「代码在哪里、为什么这样组织、如何运行、如何扩展」讲清楚。

## 文档导航

| 文档 | 内容 | 适合读者 |
| --- | --- | --- |
| [01 整体架构](./01-architecture.md) | 分层架构、运行时数据流、路由与全局弹层、跨平台形态、模块依赖 | 所有人 |
| [02 状态管理与数据模型](./02-state-and-data.md) | 全局 store、reducer 动作、SM-2 算法、每日队列、词库 JSON 结构、本地存储 | 前端开发 |
| [03 页面模块](./03-pages.md) | 8 个页面的职责、关键状态与函数、交互流程 | 前端开发 |
| [04 组件模块](./04-components.md) | App 外壳、引导页、词条详情、选词弹层、AI 助手、富文本渲染、图标 | 前端开发 |
| [05 核心库（lib）](./05-lib.md) | dict / sm2 / llm / speech / native / backup / fonts / date / richtext / constants | 前端开发 |
| [06 平台层与外围](./06-platforms.md) | Android 壳与 JNI、Windows 启动器与安装包、Serverless 代理、Service Worker、CI | 客户端 / 发布 |
| [07 构建与运行](./07-build-and-run.md) | 环境要求、npm 脚本、Vite 配置、APK / Windows 打包、数据维护脚本、排障 | 所有人 |
| [08 文件地图](./08-file-map.md) | 全仓库目录与文件职责清单 | 新人入门 |

## 项目速览

| 维度 | 说明 |
| --- | --- |
| 应用类型 | 单页应用（SPA）+ PWA + 可单文件离线分发 |
| 前端框架 | React 19（函数组件 + hooks） |
| 构建工具 | Vite 8，`@vitejs/plugin-react`，`vite-plugin-singlefile` |
| 状态管理 | 原生 `useReducer` + Context，无第三方状态库 |
| 路由 | 手写 hash 路由（`#/home`、`#/study` 等） |
| 样式 | 单文件 `src/styles.css` + CSS 变量主题，无 CSS 框架 |
| 词库 | `public/data/index.json`（轻量索引）与 `dictionary.json`（完整词条） |
| 复习算法 | SM-2（`src/lib/sm2.js`） |
| AI | OpenAI 兼容接口，SSE 流式输出；Android 内 Kilo 网关走原生 HTTP 桥 |
| 发音 | Web Speech API，失败降级到内嵌 WASM 的 DECtalk |
| 持久化 | localStorage（学习数据）、IndexedDB（自定义字体）、Cache Storage（PWA） |
| 原生壳 | Android WebView（无 Gradle 脚本化打包）、Windows C# 启动器 + Inno Setup |
| 运行时依赖 | `react`、`react-dom`、`marked`、`dompurify`、`katex` |

## 30 秒运行

```bash
npm install
npm run dev        # http://localhost:5173
```

生产构建与单文件构建：

```bash
npm run build          # dist/，注册 Service Worker
npm run build:single   # dist-single/index.html，词库内联，完全离线
```

Android / Windows 打包见 [07 构建与运行](./07-build-and-run.md)。

## 阅读路径建议

- **第一次接触项目**：README → 01 架构 → 02 状态管理 → 08 文件地图。
- **要改学习逻辑**：02（SM-2、队列、reducer）→ 03 的 Study / Practice → 05 的 `sm2.js`、`dict.js`。
- **要改 UI**：03 页面 → 04 组件 → `src/styles.css` 的 CSS 变量。
- **要接 AI 或排查网络**：05 的 `llm.js` → 06 的 `OnlineLlmBridge` / `kilo-proxy.js`。
- **要发版**：07 → 06 的 GitHub Actions。

## 文档约定

- 文档中的路径均相对于仓库根目录。
- 「关键函数」章节给出函数签名与行为说明，不逐行解释实现。
- 标注为「实验性 / 未接入」的代码表示当前构建产物不会使用，阅读时不必作为主线。
- 算法、数据结构与本地存储键名以源码为准；若代码变更，请同步更新对应文档。
