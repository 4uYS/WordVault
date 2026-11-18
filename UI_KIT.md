# 界面外观：纯白 + 圆角 + 统一图标系统

v1.0.6 起，WordVault 从「蓝色主色 / 全局直角」改为 **纯白灰阶 + 圆角 + 统一图标系统**。形状、字号、动效规范来自组件 Kit `wv-ui.css`（基于 DeepSeek chat-demo 的 CSS Modules，MIT）。

## 接入方式：渐进适配，不重写组件

项目已有一套完整的 `.btn` / `.panel` / `.setting-row` / `.thought-card` 组件与 94 项端到端回归，全量替换成 Kit 的 `wv-*` 类名会破坏功能。因此采用**三层接入**：

| 层 | 文件 | 作用 |
| --- | --- | --- |
| Kit 基础 | `src/wv-ui.css` | 组件 Kit 原文 + 纯白灰阶覆盖层 + 图标规范 + 深色桥接；提供 `wv-*` 类供后续新组件直接使用 |
| 全局重置 | `src/index.css` | 移除 `* { border-radius: 0 }` 与 `button { border-radius: 0 }`，新增圆角 token |
| 适配层 | `src/styles.css` 末尾 | 把项目现有类名桥接到 Kit 的配色与圆角数值，**不改任何 JSX 结构** |

`App.jsx` 先引入 `wv-ui.css`、再引入 `styles.css`，保证适配层优先级更高。

## 配色：零彩色

只重映射 CSS 变量，组件代码零改动：

| 变量 | 浅色 | 深色 |
| --- | --- | --- |
| `--primary` | `#252525` 墨黑 | `#f2f2f2` 近白 |
| `--bg` / `--surface` | `#ffffff` | `#151515` / `#1c1c1c` |
| `--border` | `#e8e8e8` | `#373737` |
| `--text` | `#0f0f0f` | `#fafafa` |

状态色（success / warning / danger）也中性化，风险靠文案与字重区分，不靠色相。

Kit 原生深色用 `body[data-wv-dark-theme]`，项目主题写在 `<html data-theme="dark">`，`wv-ui.css` 末尾有专门的深色桥接段重声明 Kit 的 alias 变量。

可选强调档：给 `<body>` 加 `data-wv-emphasis="outline"`，连主按钮也变纯白，只靠 2px 边框与字重分层。

## 圆角

Kit 的圆角是**写死数值**而不是 token，适配层按组件语义分档：

- `--r-pill: 4096px`：全部按钮、icon-btn、chip、徽标
- `--r-md: 16px`：面板、卡片、提示框、AI 输出区、选词弹层、练习卡
- `--r-lg: 24px`：词条详情、弹层、AI 输入条
- `12px`：Toast
- `14px`：`.thought-card` 保持此前确认的值，避免破坏思考卡片的视觉与回归

## 图标系统

原来 `Icons.jsx` 内联了 42 个手写 SVG，`stroke-width` 混着 1.7/1.8/1.9，端点是 `square`、拐角是 `miter`，还有几处用字符当图标。现在统一为：

```
24×24 网格 · 2px 安全边距 · stroke 1.75
round 端点/拐角 · fill:none · currentColor
```

- **91 枚 symbol** 内联在 `index.html`（49 枚重设计 + 42 枚规范化后的 legacy 几何），单文件 HTML 无需外部请求
- `Icons.jsx` 的公共 API **完全不变**：`Icon({ name, size, className })` 内部改为 `<use href="#wv-i-...">`，25 个常用名映射到新图标，其余走 `wv-i-legacy-<name>`
- 图标颜色继承父容器文字色，浅色 / 深色主题自动适配，不需要单独做深色图标
- `LogoMark` 补了 6px 圆角
- AI 思考卡片的 `.fold-head` 专用线稿图标（`SVG_DEFS`）保持不变，避免破坏既有回归

### 加新图标

在 `index.html` 的 sprite 里加一个 `<symbol id="wv-i-xxx" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">`，然后 `Icon({ name: 'xxx' })` 即可。

## 落地边界（重要）

**没有**把现有页面重写成 Kit 的 `wv-btn` / `wv-chat-input` / `wv-messages` 结构——那会改变 AI 对话、思考卡片、确认流程等已验证的交互。当前是「视觉规范落地 + Kit 作为可用基础」，后续可以逐个组件迁移到原生 `wv-*` 类。

## 验证

| 项目 | 结果 |
| --- | --- |
| `npm run lint` | 0 error（108 条为原有 warning） |
| `scripts/validate-agent.mjs` | 65 / 65 |
| `scripts/validate-nearby.mjs` | 49 / 49 |
| 端到端回归 | 114 / 114 |
| UI 专项（纯白配色、圆角、91 枚 symbol 全部可解析、currentColor、深浅主题、8 条路由、3 种视口） | 32 / 32 |
| `npm run build` / `npm run build:single` | 均通过 |

单文件 HTML 体积 22.2 MB（Kit CSS + sprite 约 +80 KB），APK / EXE 仍为压缩后的 ~7 MB。
