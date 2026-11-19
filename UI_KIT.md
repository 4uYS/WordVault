# 界面外观与图标系统

当前（v1.0.8）：**纯白灰阶 + 直角 + 统一图标系统**。

## 形状：全局直角

v1.0.6 / v1.0.7 曾接入组件 Kit 的圆角，先因白名单漏了 25 类容器出现「有的圆有的方」，修成全局兜底后用户决定整体回退。

现在由 `src/index.css` 一处保证：

```css
*, *::before, *::after { box-sizing: border-box; border-radius: 0; }
button { cursor: pointer; border-radius: 0; }
```

`src/styles.css` 末尾的适配层**不声明任何 `border-radius`**，原文件里零散的 4px / 14px 也已归零。唯一的例外是两处 `border-radius: 50%`——圆形指示点与头像，属于原项目既有图形，不是卡片圆角。

想再加回圆角时，不要只给一份手写清单设值；要么保留全局 `border-radius: 0` 并逐类覆盖，要么删掉它后用一条 `:where(:is([class*="card"], [class*="panel"], …))` 兜底规则统一设值。注意 `:not()` 链必须写在同一行，换行会被解析成后代选择器而使整条规则失效。

## 配色：零彩色

只重映射 CSS 变量，组件代码零改动。

| 变量 | 浅色 | 深色 |
| --- | --- | --- |
| `--primary` | `#252525` 墨黑 | `#f2f2f2` 近白 |
| `--bg` / `--surface` | `#ffffff` | `#151515` / `#1c1c1c` |
| `--border` | `#e8e8e8` | `#373737` |
| `--text` | `#0f0f0f` | `#fafafa` |

状态色（success / warning / danger）也中性化，风险靠文案与字重区分，不靠色相。

可选强调档：给 `<body>` 加 `data-wv-emphasis="outline"`，连主按钮也变纯白，只靠 2px 边框与字重分层。

## 图标系统（保留）

原来 `Icons.jsx` 内联了 42 个手写 SVG，`stroke-width` 混着 1.7/1.8/1.9，端点是 `square`、拐角是 `miter`，还有几处用字符当图标。现在统一为：

```
24×24 网格 · 2px 安全边距 · stroke 1.75
round 端点/拐角 · fill:none · currentColor
```

- **91 枚 symbol** 内联在 `index.html`（49 枚重设计 + 42 枚规范化后的 legacy 几何），单文件 HTML 无需外部请求
- `Icons.jsx` 的公共 API **完全不变**：`Icon({ name, size, className })` 内部改为 `<use href="#wv-i-…">`，25 个常用名映射到新图标，其余走 `wv-i-legacy-<name>`
- `.wv-icon` 基础规范在 `styles.css` 适配层；symbol 自身也带全套属性，双重保证
- 图标颜色继承父容器文字色，浅色 / 深色主题自动适配，不需要单独做深色图标
- `LogoMark` 补了 6px 圆角（这是 logo 图形，不是卡片圆角）
- AI 思考卡片的 `.fold-head` 专用线稿图标（`SVG_DEFS`）保持不变

### 加新图标

在 `index.html` 的 sprite 里加一个 `<symbol id="wv-i-xxx" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">`，然后 `Icon({ name: 'xxx' })` 即可。

## 落地边界

组件结构从未重写成 Kit 的 `wv-*` 类名，`src/wv-ui.css` 已在 v1.0.8 删除。现有 `.btn` / `.panel` / `.thought-card` 等类名与全部交互逻辑保持原样。

## 验证

| 项目 | 结果 |
| --- | --- |
| `npm run lint` | 0 error（108 条为原有 warning） |
| `scripts/validate-agent.mjs` | 65 / 65 |
| `scripts/validate-nearby.mjs` | 49 / 49 |
| 端到端回归 | 114 / 114（思考卡片断言改为直角） |
| UI 专项（纯白配色、**逐页实测 92 个卡片状容器零残留圆角**、91 枚 symbol 全部可解析、currentColor、深浅主题、8 条路由、3 种视口） | 37 / 37 |
| `npm run build` / `npm run build:single` | 均通过 |
