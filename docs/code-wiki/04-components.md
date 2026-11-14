# 04 组件模块

## 1. 组件清单

| 组件 | 文件 | 类型 | 职责 |
| --- | --- | --- | --- |
| `App` | `src/App.jsx` | 根组件 | 路由、全局弹层、Toast、UIContext Provider |
| `Shell` | `src/App.jsx` | 布局 | 顶栏 / 页面 / 底部导航 / 提醒调度 |
| `AppHeader` | `src/App.jsx` | 布局 | 品牌、查词入口、主题切换 |
| `BottomNav` | `src/App.jsx` | 布局 | 5 个主 tab |
| `ReminderWatcher` | `src/App.jsx` | 副作用组件 | 每日提醒（原生 / 浏览器两套实现） |
| `Toast` | `src/App.jsx` | 反馈 | 顶部短提示，2.4 秒自动消失 |
| `Onboarding` | `src/components/Onboarding.jsx` | 全屏流程 | 首次使用 4 步引导 |
| `WordDetail` | `src/components/WordDetail.jsx` | 弹层 | 完整词条详情 + 收藏 + 掌握度 + AI |
| `SelectionPopup` | `src/components/SelectionPopup.jsx` | 浮层 | 选中英文后取词 |
| `AiAssistant` | `src/components/AiAssistant.jsx` | 内嵌区块 | 词条级 AI 例句 / 精讲 |
| `StreamingText` | `src/components/RichText.jsx` | 渲染 | 逐字流式文本 |
| `RichMarkdown` | `src/components/RichText.jsx` | 渲染 | Markdown + LaTeX 安全渲染 |
| `Icon` | `src/components/Icons.jsx` | 基础 | SVG 图标集 |
| `LogoMark` | `src/components/Icons.jsx` | 基础 | 品牌标志 |

## 2. App.jsx

### 2.1 `currentRoute()`

```js
window.location.hash.replace(/^#\/?/, '') || 'home'
```

只做字符串解析，不校验路由是否存在；未知路由由 `Shell` 兜底到 Home。

### 2.2 `App`

职责：

1. 维护 `route`、`detailWord`、`toast` 三个顶层状态。
2. 监听 `hashchange`，更新路由并滚动到顶部；首次无 hash 时写入 `#/home`。
3. 用 `useCallback` 固化 `navigate` / `openWord` / `showToast`，再用 `useMemo` 组成 `ui` 对象。
4. `profile` 为空时**直接返回 `Onboarding`**，不渲染 Shell。
5. 正常渲染：

```jsx
<UIContext.Provider value={ui}>
  <Shell ... />
  {detailWord && <WordDetail word={detailWord} onClose={...} />}
  <SelectionPopup />
  <Toast message={toast} />
</UIContext.Provider>
```

`navigate(path)` 的细节：

```js
const next = `#/${String(path).replace(/^\/+/, '')}`
if (window.location.hash === next) window.scrollTo({ top: 0, behavior: 'smooth' })
else window.location.hash = next
window.scrollTo({ top: 0 })
```

### 2.3 `Shell`

- `base = route.split('/')[0].split('?')[0]`。
- `focus = ['study', 'practice', 'wrong'].includes(base)`，focus 模式隐藏 `AppHeader` 与 `BottomNav`。
- `theme` 本地状态来自 `document.documentElement.dataset.theme`，并随 `settings.theme` 更新（含 `system` 的媒体查询）。
- **`#/theme` 伪路由**：检测到 `route === 'theme'` 时 dispatch 切换主题，然后 `navigate(base)` 回到原页面。导航按钮只负责跳 `theme`，实际逻辑在 Shell。
- 页面选择是 `if/else` 链，`practice` 会把 `route.split('/')[1]` 作为 `mode` 传给组件。
- `<div key={route} className="page-transition">` 让每次路由变化重新触发入场动画。

### 2.4 `ReminderWatcher`

总是挂载在 Shell 内，但两套逻辑互斥：

**原生（Android）**

```js
if (!reminder || profile.notify === false) cancelDailyReminder()
else scheduleDailyReminder(reminder, title, body)
```

依赖 `reminderTime` 与 `notify`，变化时重新调度 AlarmManager。

**浏览器**

- 要求 `reminderTime` 存在、`notify !== false`、`Notification` 可用。
- 每 30 秒检查一次当前时间是否 ≥ 提醒时间。
- 每天只弹一次，用 `localStorage` 键 `wordvault.reminder.YYYY-MM-DD` 去重。
- 今日新词与到期词都为 0 时不弹。
- 页面关闭后不再提醒（浏览器限制）。

### 2.5 `BottomNav` / `AppHeader`

- `BottomNav` 5 个 tab：今日 / 词库 / 查词 / AI / 我的；当前 tab 依据 `base` 高亮。
- `AppHeader` 包含品牌按钮（回首页）、本地存储标识、查词按钮、主题切换按钮。
- 主题图标由 Shell 传入的 `theme` 决定（dark 显示太阳，light 显示月亮）。

## 3. Onboarding

**触发条件**：`state.profile === null`。

**4 个步骤**：

| step | key | 内容 | 继续条件 |
| --- | --- | --- | --- |
| 0 | identity | `IDENTITIES` 多选标签 | 至少选 1 个 |
| 1 | goal | `GOALS` 单选卡片，标注默认词书 | 已选择 |
| 2 | level | `LEVELS` 单选列表，选择后自动带出推荐 `dailyNew` | 已选择 |
| 3 | plan | 每日新词、提醒时间、通知开关、计划预览 | 总是可完成 |

**`finish()` 行为**：

1. 若开启通知：原生调用 `requestNotificationPermission()`；浏览器在 `permission === 'default'` 时请求权限（失败不阻塞）。
2. dispatch：

```js
{
  type: 'COMPLETE_ONBOARDING',
  profile: {
    nickname: '词库旅人', identities, goal, level, dailyNew,
    dailyReview: DEFAULT_DAILY_REVIEW, reminderTime, notify,
    createdAt: Date.now(),
  },
  bookId: selectedGoal?.book || 'cet4',
  settings: { accent: 'us' },
}
```

3. 跳转 `#/home`。

昵称固定为「词库旅人」，进入个人中心后可修改。

## 4. WordDetail

**入口**：`App` 的 `detailWord` 非空时渲染；任意页面调用 `openWord(word)`。

**数据来源**：

```js
const full = lookupFull(word)
const basic = dict.lookupBasic(word)
const data = full || { w: word, uk, us, tr: [...], ex: [], ph: [], syn: [], ... }
```

- 完整词库未就绪时显示「正在读取完整词条」，并调用 `ensureFullDict()`。
- 即使完整词库缺失，也能用索引兜底展示一条释义。
- 记录键统一用 `full?.w || word`。

**行为**：

| 功能 | 实现 |
| --- | --- |
| 关闭 | 点击遮罩、关闭按钮、`Esc` |
| 滚动锁定 | 挂载时 `body.overflow = hidden`，卸载恢复原值 |
| 收藏 | `TOGGLE_FAVORITE`，收藏后 `due = now` 立即纳入复习 |
| 掌握度 | `SET_STATUS` unknown / familiar / known |
| 发音 | 英/美音标按钮、例句朗读，均调用 `speak` |
| 关联词跳转 | 同义词、反义词、同根词点击后 `openWord` 替换当前详情 |
| AI | 底部嵌入 `AiAssistant` |

**展示区块**（按数据存在性条件渲染）：释义、例句、常见搭配、同义词/反义词、同根词族、词根助记、AI 学习助手、掌握程度、数据来源说明。

## 5. SelectionPopup

**目标**：在任意页面选中英文（鼠标拖选 / 手机长按 / 键盘选择）后，弹出本地释义浮层。

**事件绑定**（`dict.indexReady` 后才绑定）：

- `mouseup` / `touchend` / `keyup` → 延迟 120ms 读取选区。
- `selectionchange` → 延迟 80ms，选区为空则关闭。
- `mousedown` / `touchstart` → 点击浮层外部关闭。
- `scroll`（捕获）/ `resize` → 关闭。

**过滤规则**：

- 选区为空或长度 > `MAX_SELECTION = 80` 不弹。
- 锚点位于 `input`、`textarea`、`contenteditable`、`.word-detail`、`.selection-popup` 内不弹。

### 5.1 词形还原 `stemVariants(word)`

按后缀生成候选原形：

| 后缀 | 候选 |
| --- | --- |
| `ies` | `y` 结尾 |
| `ves` | `f` 结尾 |
| `es` / `s` | 去尾 |
| `ied` | `y` 结尾 |
| `ed` | 去掉 `ed`、去掉 `d` |
| `ing` | 去掉 `ing`、`ing` → `e` |
| `est` / `er` / `ly` | 去尾 |
| 双写辅音 | 再去掉一个重复字母（running → runn → run） |

### 5.2 `candidateWords(text)`

1. 去掉首尾空白与常见标点。
2. 如果整体是单个英文词，直接使用；否则用正则提取所有英文 token。
3. 按长度降序，先放原词再放还原词，去重。

### 5.3 定位

- 浮层宽度固定 312px。
- 水平居中于选区，并限制在视口内。
- 默认在选区下方 10px；若下方空间不足 200px，则翻到上方。

**未收录词**：仍弹出浮层，提示「本地词库暂未收录」，按钮变为「AI 解析」，打开详情后可让 AI 生成解释。

## 6. AiAssistant

**位置**：`WordDetail` 内部，针对当前词条。

**两种模式**：

| mode | 按钮 | 提示词 | maxTokens | temperature |
| --- | --- | --- | --- | --- |
| `example` | AI 例句 | `buildExampleMessages` | 360 | 0.6 |
| `explain` | AI 精讲 | `buildExplainMessages` | 400 | 0.6 |

**状态恢复**：切换词条（`entry.w` 变化）时读取 `state.ai.entries[word]`：

- 两种结果都存在时，选择 `at` 较新的一个；
- 只有一种时选该种；
- 都没有则清空。

**生成**：

- `generate({ onToken })` 实时更新文本，`StreamingText` 渲染。
- 完成后 `AI_SAVE_ENTRY` 持久化并显示保存时间。
- 已保存时按钮文案变为「重新生成」，并提供「清除结果」（`AI_CLEAR_ENTRY`）。
- 生成中显示「停止」，调用 `cancelGeneration()`。

## 7. RichText

### 7.1 `StreamingText`

- 用真实 DOM 追加字符，**不经过 React 重渲染**，避免每个字符都重启动画。
- 首次挂载和文本变短时清空容器。
- 只追加 `text.slice(renderedRef.current)` 的新字符。
- 每个字符包在 `<span class="ink-char">` 中，`animationDelay` 最多 240ms；换行转为 `<br>`。
- 文本里的 Markdown 在流式阶段按纯文本显示，结束后才由 `RichMarkdown` 渲染。

### 7.2 `RichMarkdown`

- `useMemo(() => renderRich(text), [text])`，`dangerouslySetInnerHTML` 注入。
- `renderRich` 的处理顺序：
  1. 剥离 `$$...$$`、`\[...\]`、`\(...\)`、`$...$` 公式，替换成 `@@KATEXn@@` 占位符；
  2. `marked.parse` 渲染 Markdown；
  3. `DOMPurify.sanitize` 清洗；
  4. 将占位符替换为 `katex.renderToString` 生成的 HTML。

> 注意：KaTeX 输出是在 DOMPurify **之后**注入的。KaTeX 自身会对内容转义，且 `throwOnError: false`，但若未来允许用户控制公式来源，需要重新评估该顺序。

## 8. Icons

```jsx
<Icon name="search" size={20} className="..." />
```

- 所有图标是同一套 24×24 线性 SVG，`stroke="currentColor"`，默认线宽 1.7，`strokeLinecap="square"`。
- 图标定义在 `paths` 对象中；未知名称回退到 `info`。
- 常见名称：`home`、`book`、`search`、`user`、`volume`、`volumeSmall`、`chevronLeft/Right/Down`、`arrowRight`、`check`、`close`、`sun`、`moon`、`play`、`clock`、`target`、`spark`、`lock`、`database`、`download`、`upload`、`trash`、`alert`、`palette`、`font`、`list`、`keyboard`、`pen`、`shuffle`、`edit`、`info` 等。
- `LogoMark` 是品牌方块标志，颜色取自 `--primary` / `--on-primary`。

## 9. 样式体系

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `src/index.css` | 50 | 全局重置、`html/body/#root` 基础样式 |
| `src/styles.css` | 5,929 | 全部页面与组件样式，按页面分区注释 |
| `src/App.css` | 184 | Vite 模板遗留，**未被引用** |

`styles.css` 的组织顺序：

1. 顶部 `@font-face`：内嵌 IPA 字形子集（Noto Sans latin-ext），保证 `ə / ɪ / ʊ` 等音标不变方框。
2. CSS 变量与主题（`:root`、`[data-theme="dark"]`）。
3. 通用文字、按钮、布局骨架、进度条、底部导航、Toast、状态标签、加载/空态。
4. 逐页面区块：首页（周图表、练习入口）、词库、查词、学习闪卡、练习、错词本、AI、个人中心。
5. 响应式与矮视口适配（压缩闪卡，确保评分按钮在首屏）。
6. Markdown / KaTeX 渲染样式与 `.ink-char` 流式动画。

主题切换由 `AppProvider` 写入 `document.documentElement.dataset.theme`，所有颜色通过 CSS 变量响应，不需要 React 重渲染整个页面。

## 10. 组件依赖图

```text
App
├── Onboarding
├── Shell
│   ├── AppHeader ── Icon / LogoMark
│   ├── pages/*
│   └── BottomNav ── Icon
├── WordDetail
│   ├── Icon
│   └── AiAssistant ── RichText / Icon
├── SelectionPopup ── Icon
└── Toast ── Icon
```
