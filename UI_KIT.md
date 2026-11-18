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

## 圆角：全局兜底，不是白名单

原项目靠 `index.css` 的 `* { border-radius: 0 }` 实现全直角。第一版适配层删掉那句后，**只给一份手写 `:is()` 清单设圆角**，结果清单外的 25 类容器（`task-hero` / `stat-strip` / `week-summary` / `profile-head` / `mode-card` / `book-tab` / `word-list` / `search-field` / `ai-composer` …）落回 UA 默认 0，出现「有的圆有的方」。

现改为**两层**：

1. **全局兜底**：一个 `:where(:is([class*="card"], [class*="panel"], …):not(…))` 规则，把所有卡片状容器默认设为 `16px`。属性包含选择器让未来新增的 `*-card` / `*-panel` / `*-strip` 自动生效，不必再补清单；整条包在 `:where()` 里使特异性为 0，后面的具名规则可以覆盖它。
   - 例外：`.app-header` / `.bottom-nav` / `.brand` / 进度条 / spinner 等全宽结构条显式 `:not()` 排除，保持直角。
   - **坑**：`:not()` 之间不能换行或留空格——CSS 会把 `:not(A)\n :not(B)` 解析成后代选择器，整条规则失效；且裸露在 `:where()` 外的 `:not()` 链会把特异性堆到 0,12,0，反过来压掉 `.word-chip` 的 4096px 胶囊值。所以整个选择器写在一行并包进 `:where()`。
2. **精确值覆盖**：按钮 / icon-btn / chip / 无类名裸按钮 `4096px`；词条详情与弹层 `24px`；Toast `12px`；`.thought-card` 保持原先确认的 `14px`；输入框 `16px`，AI 输入条 `24px`。

另有 `.profile-head`、`.study-review-meta`、`.task-status`、`.practice-start-row`、`.onboarding-step` 这几个不含语义词的区块显式补齐。

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
| UI 专项（纯白配色、圆角、91 枚 symbol 全部可解析、currentColor、深浅主题、8 条路由、3 种视口、**逐页实测 92 个卡片状容器零遗漏直角**） | 35 / 35 |
| `npm run build` / `npm run build:single` | 均通过 |

单文件 HTML 体积 22.2 MB（Kit CSS + sprite 约 +80 KB），APK / EXE 仍为压缩后的 ~7 MB。
