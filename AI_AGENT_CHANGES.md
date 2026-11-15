# WordVault AI Agent 改动说明

在 `4uYS/WordVault` main 分支源码基础上，把 v2 提示词规格落地为可运行代码，并构建出完全离线的单文件 HTML。

## 改了什么

| 文件 | 改动 |
|---|---|
| `src/lib/llm.js` | 新增 `AGENT_SYSTEM`（44 个能力的 JSON 指令协议）、`LOOKUP_SYSTEM`（缺词补录）、`buildLookupMessages()`、`parseAgentReply()`；`buildChatMessages()` 系统提示切到 Agent 版。例句 / 精讲 / 出题三个旧 builder 保持原样，`parseQuiz()` 不受影响 |
| `src/lib/agentTools.js` | 新增。44 个工具的注册表、参数白名单与枚举双层校验、脱敏 `[上下文]` / `[工具结果]` 拼装、异步执行器 |
| `src/lib/dict.js` | 新增自定义词条覆盖层：`setCustomWords()` 合并进 index / dictionary 视图，派生索引条目，`dictionaryStats()` / `isCustomWord()` 等接口。静态 `data/*.json` 仍只读 |
| `src/AppContext.jsx` | `state.customWords`、`sanitizeEntry()` 字段清洗、三个 reducer 分支（UPSERT / PATCH / REMOVE）、备份导入兼容、渲染阶段同步覆盖层 |
| `src/pages/AiChat.jsx` | 解析 B 类 JSON、自动执行 L0/L1、只读结果回灌第二轮、L2/L3 渲染确认卡片、确认后才 dispatch、执行结果回显。**保留原版 `onToken` 逐字流式**（两轮生成都带回调）；指令 JSON 的流式增量收进「实时输出」折叠区，避免碎片糊屏 |
| `src/pages/SearchPage.jsx` | 零结果时出现「让 AI 补录」按钮，跳 `#/ai?lookup=xxx` |
| `src/components/SelectionPopup.jsx` | 未收录词的「AI 解析」改为「AI 补录」 |
| `src/App.jsx` | 向查词页传 `navigate` |
| `src/styles.css` | **未新增任何样式类**；确认卡片全部复用项目内置类：`.ai-quiz-entry` / `.ai-quiz-actions` / `.section-head.compact` / `.setting-label` / `.tiny-note` / `.data-size` / `.word-chip` / `.ai-output` / `.ai-actions` / `.ai-explain` / `.ai-error` / `.btn` |
| `scripts/validate-agent.mjs` | 新增：42 项逻辑自检（提示词、校验、覆盖层、执行器、脱敏） |

## 能力分级

- **L0 只读 / L1 轻交互**：自动执行，无需确认（查词、统计、学习记录、朗读、跳转、切主题、测试通知等）
- **L2 写**：必须用户点确认（改昵称、切词书、标记状态、清缓存、导出备份、每日提醒等）
- **L3 高敏**：强确认 + 文案需含「不可撤销 / 覆盖」（补录词条、修正释义、删自建词条）

永久黑名单：导入备份、重置数据、读取或改 API Key、改 SM-2 内部字段、伪造学习时长、删内置词条、批量 > 20 条。提示词与宿主校验各拦一次。

## 补录词条失效的修复（对话里说「加入词书」没反应）

现象：查词、改昵称、弹词条都正常，唯独 AI 补录不出现确认卡片。

根因（三层，都发生在写库之前）：
1. **生成层**：`LOOKUP_SYSTEM`（含完整 entry 字段模板）只在查词页 `#/ai?lookup=` 入口使用。用户在 AI 对话里说「帮我补录 / 加入词书」时走的是 `AGENT_SYSTEM`，里面只写「entry 结构见缺词补录提示词」——模型根本看不到模板；再加上硬约束把超长专业词当作可疑词，于是只输出 A 类文本反问（例如「需要的话我可以帮你准备好补录内容…」），一个指令都不产出。
2. **校验层**：`word.upsert` 是唯一的 L3 补录工具，门槛最严：confirm 必须含「不可撤销/覆盖」、`entry.w` 必须与 word 一致、`tr` 必须是标准数组、`books` 必须是合法 id。免费小模型几乎总会踩中一条，`validateActions` 直接整批拒绝 → 确认卡片不渲染。
3. **截断**：`maxTokens: 700` 对「完整词条 JSON + reply + actions」偏紧，JSON 被截断后解析失败，降级成普通正文。

修复：
- `AiChat.send()` 增加补录意图识别（补录 / 收录 / 加入词书…），从上文提取未收录的候选英文词（长词优先），自动改用 `LOOKUP_SYSTEM` + `[上下文] userConfirmed: true`；`AGENT_SYSTEM` 也内联了 entry 简化结构。
- `agentTools.js` 新增 `normalizeUpsertEntry()`：模型省略 `w`、用 `{c,p}` 简写、把 books 写成「四级词汇」、写非法 id，都由宿主补齐/映射成标准词条；只有「完全没给释义」才拒绝。
- L3 confirm 漏关键字不再整批拒绝，由宿主补「（此操作不可撤销，请确认）」，安全提示仍写在卡片上。安全边界（工具白名单、参数键、枚举、批量上限、凭据黑名单）一律未放宽。
- `maxTokens` 700 → 1200；校验失败但模型确实想补录时，自动换专用提示词重试一次。
- 已收录的词不再抛错，改为把新词书合并进覆盖层（「把 xx 加入考研词书」也能生效），原释义不动。

回归脚本：`scripts/reproduce-upsert.mjs` 复现四种典型模型写法，`scripts/validate-agent.mjs` 的 `[2b]` 组逐项验证归一化。

## 长文朗读失效的修复（只吐出一段没解析的 JSON）

现象：让 AI 写文章并朗读，第一次提示 `speech.speak：朗读文本需为 1–200 字符`；模型学乖后拆成三段并输出 JSON，界面却把整坨 JSON 当正文显示，一个字都没读。

三个根因：
1. **解析层**：`parseAgentReply()` 原先要求 trim 后整体以 `{` 开头。模型在 JSON 前加了一句中文（「全文超过单次朗读上限，已按三段拆好，将依次播放：」），直接降级成 plain，指令被当成正文渲染。
2. **校验层**：`speech.speak` 人为设了 200 字符上限，整篇文章必然被整批拒绝。
3. **播放层**：`speak()` 内部每次调用都 `synth.cancel()`，即便模型拆成三个动作被逐个执行，后一个也会打断前一个，实际播不出来。

修复：
- `parseAgentReply()` 改为**括号配对扫描**：从文本里提取第一个完整且合法的 JSON 对象（跳过字符串内的花括号、支持嵌套），前后夹带文字记入 `stray` 不混入 `reply`。仍要求对象含 `reply` + `actions` 才认指令，普通 JSON 片段不会被误判成写操作。
- `speech.speak` 上限 200 → 4000；提示词明确「长文直接给全文，宿主自动按句分片，不要自己拆」，并禁止 L0/L1 的 reply 写「请确认」。
- 新增 `speakLong()`：按句边界切成 ≤200 字符片段，**只 `cancel()` 一次**再依次入队；DECtalk 降级路径直接读全文。`executeTools` 会把模型拆出的连续多个 `speech.speak` 先合并成一次长文朗读。
- `agentRound()` 纯 L1 动作执行完直接收尾，不再回灌第二轮（只有 L0 只读查询才需要回灌），少一次请求也少一次格式出错的机会。
- 流式草稿识别放宽：文本里出现 `"actions"` / `"reply"` 就收进「实时输出」折叠区，中文前缀开头也不会把 JSON 糊在气泡里。

回归：`validate-agent.mjs` 的 `[1]`（混合文本 / 普通 JSON 不误判 / 嵌套括号）与 `[2c]`（分片、只 cancel 一次、三个动作合并）；`e2e_check.py` 的 `[7]` 在浏览器里注入假 `speechSynthesis`，验证真的入队多段且气泡里不再出现原始 JSON。

## 执行过程账本（思考过程显示修复）

### 原来的问题

`onStream` 每收到一个 token 都 `setMessages([...history, userTurn, {assistant, content: full}])`，**整条 assistant 消息被反复覆盖**。后果：

- 两阶段协议里第二轮生成会把第一轮的指令 JSON、「实时输出」折叠区全部冲掉，用户看到「先闪一段 JSON → 突然变答案」；
- 工具调用、执行结果、回灌、校验拦截、补录重试这些中间阶段没有任何独立节点，只在最后一次性塞进一个「查询结果」折叠区；
- 「正在生成操作指令…」是临时态，回答结束即消失，无法回看；出错或点「停止」时 catch 直接把 assistant 气泡删掉，过程全丢；
- 没有状态、没有耗时、失败也不突出。

### 调研后采用的模式

参考主流 Agent 界面的共识做法：

- **渐进式披露**：结论常显 / 证据折叠成一行摘要 / 原始 trace 深折叠；默认收起，但完成后仍可展开回看，失败项默认展开并标红 [citation:1][citation:9]
- **Live step ledger**：纵向步骤列表，pending 空心圆 / running 动画 / done 勾 / failed 叉，运行中的步骤固定在视野内，失败步骤保留在 ledger 里 [citation:13]
- **Tool call cards**：每个外部动作一张卡片，工具名、结果摘要、耗时、状态；连续相同调用合并计数 [citation:13][citation:16]
- **Dify 的幂等增量更新**：`agent_thought` 按 position/id 定位替换或追加，思维链渲染成可折叠卡片「已使用 XXX 工具」，消息内按「思维链 → 正文」固定顺序拼装，各区块独立增量更新互不干扰 [citation:6]
- **Vercel AI SDK `fullStream` 分流**：`text-delta` 进正文，`tool-call` / `tool-result` 单独渲染，不混进答案 [citation:5]
- 反模式对照：过程跑完就消失、泛泛的「处理中」、无耗时、把失败折进去、默认全展开把答案埋掉 [citation:9][citation:13]

### 落地实现

- `AiChat.jsx` 新增 `TraceLedger` + `makeLedger`：本轮 `trace` 数组为权威数据，按 `id` 幂等追加/替换；渲染态只做同步，最后随消息一起存进 `state.ai.chat`，刷新后仍可回看。
- 步骤类型：`think`（生成）/ `plan`（解析出动作清单）/ `tool`（执行组 + 每个实际执行单元）/ `refeed`（结果回灌）/ `retry`（换补录提示词）/ `blocked`（拦截）/ `confirm`（等待确认）/ `error`（中断）。
- `executeTools` 新增 `outcomes` 返回（每项 `{tool, text, ok, ms}`），连续朗读合并后条数可能少于 actions，账本按实际执行单元记，不会错位。
- 流式与账本分离：指令 JSON 增量进「实时输出」折叠区，普通文本走 `StreamingText` 逐字晕开；第二轮生成不再覆盖第一轮已落账的步骤。
- 出错 / 主动停止时保留 assistant 气泡并 `failAll()`，把中断原因写进账本，不再抹掉过程。
- 确认 / 忽略写操作后，对应 `pending` 步骤同步改为 `done` / `failed`。
- **零新增 CSS**：账本全部复用内置类 `details.ai-output` / `summary.setting-label` / `summary.ai-load-row` / `.word-chip.static/.danger` / `.data-size` / `.tiny-note` / `.ai-error`，深浅主题自动跟随。

回归：`e2e_check.py` 的 `[8]` 验证两阶段六步账本（运行中展开、完成后折叠可回看、含工具名/状态/耗时、第二轮确为结果回灌）；`[9]` 验证失败步骤自动展开且标红。

## 二次改版：对标千问的阅读式「已完成思考」抽屉（已被「三版」替换，保留作演进记录）

第一版把过程做成了**塞在气泡里的调试日志**：`<details>` 里每行一个状态徽章（◌ ✓ ✕ ○）+ `.data-size` 耗时 + 工具名，像 DevTools 的 network 面板。对照千问智能体的实际界面，差距很清楚：

| 千问 | 第一版 |
|---|---|
| 对话流里只有一行「已完成思考 ›」，点开是**独立全屏抽屉** | 折叠块塞在 assistant 气泡里，和答案挤在一起 |
| 抽屉里是**叙事段落 + 可折叠思考节点 + 一行行动状态**（「已加载浏览器操作技能」「已执行代码」「已完成查找」） | 结构化字段表：工具名 / 状态符号 / 毫秒数 |
| 有第一人称自述（「我先打开你给的链接…」「页面内容在一个嵌套预览框里…」），读起来像看它干活 | 全是工程符号，没有一句完整的话 |
| 子项是「• 正在处理历史版本提示 点击查看详情」式的轻量下钻 | 每行都挂徽章和耗时，视觉密度高 |
| 答案与过程物理分离，收起后答案完整 | 答案上方压着一个 details 块 |
| 完成后仍可点开回看 | 也能回看，但观感像日志 |

**改法**（`src/pages/AiChat.jsx`，仍零新增 CSS）：

- 气泡里只留 `ThoughtChip`：运行中「正在思考… · 当前阶段」，完成后「已完成思考 · N 步」，失败时变红字「执行遇到问题」。
- `ThoughtPanel` 复用词条详情的内置弹层：`.modal-backdrop` / `.word-detail` / `.detail-header` / `.detail-heading` / `.detail-body` / `.detail-section` / `.section-help` / `.ai-output` / `.ai-load-row` / `.ai-explain` / `.ai-error` / `.btn`。移动端 `.modal-backdrop` 本来就是 `padding: 0` 全屏，天然接近千问的 bottom sheet。支持点遮罩 / 关闭按钮 / Esc 关闭。
- 过程流四种形态：**叙事段落**（`detail-section > p`）、**可折叠思考节点**（云朵 + 标题 + 下箭头，展开看参数/结果）、**一行行动状态**（「已查学习统计：…」+「点击查看详情」下钻）、**错误节点**（默认展开 + 红字）。
- **不伪造思维链**：叙事段落用第一轮指令 JSON 里模型真实写下的 `parsed.reply`（如「正在查询你的复习进度。」），宿主补的只是客观步骤说明（「已执行…」「正在回灌…」）；抽屉头部明确写「以下为本次执行的真实步骤记录」。这个项目走的是提示词约定 JSON，模型没有输出自由 reasoning，凭空生成「我认为…」是不诚实的。
- 去掉每行 `✓ / ✕ / ◌` 徽章与 `.data-size` 耗时，总耗时只在抽屉头部汇总一次；失败仍浮到顶层（入口变红 + 节点默认展开），符合「失败优先」原则。
- `trace` 仍按 id 幂等更新、随消息持久化，刷新后点开仍能看到完整过程。

回归：`e2e_check.py` 的 `[8]`（抽屉打开/关闭/自述段落/动作行/无徽章/答案完整）与 `[9]`（失败入口标红、错误项默认展开）。

## 三版（最终）：按 demo 的 CSS 平铺到聊天文档流

用户给了 `复刻界面demo.html`。关键点在 demo 自己的注释里：**「平铺的思考过程：文档流内的普通区块，无遮罩、无浮层」**。上一版做成了独立抽屉（`.modal-backdrop`），方向还是错的。这一版按 demo 重写：

- **删除** `ThoughtPanel`（抽屉）、`openThought` 状态、`.modal-backdrop` / `.word-detail` 依赖；思考过程回到 assistant 气泡内的 `.thought-card`，和答案同处聊天流，顺序是「用户气泡 → 思考卡片 → 答案」。
- **照搬 demo 的结构与类名**：`.thought-card` 圆角 14px 白卡、`.thought-head`（「已完成思考」+ 自绘 disclosure）、`.thought-content.collapsed`、`.intro`（模型真实自述）、`.fold-head`（线稿图标 + 标题 + disclosure）、`.fold-body`、`.step`（一行「已 XXX」）、`.bullet`（圆点 + 「点击查看详情」）、`.thought-answer`。
- **展开控件完全按 demo**：`<circle class="ring">` + `.mark.up` / `.mark.down` 两条折线，靠 `[aria-expanded]` 切 `opacity` 显隐，**不做任何旋转**；顶层卡片默认展开（demo 的 `aria-expanded="true"`），点击收起，运行中强制展开。
- **图标库按 demo 复制**：`i-cloud / i-puzzle / i-code / i-check / i-image / i-tool`，另补一个 `i-alert` 给失败节点；用 `<svg><defs>` 挂一次 + `<use href="#i-xxx">` 复用。`makeLedger.add()` 会按步骤语义自动挑图标（思考→云朵、加载技能→拼图、执行/回灌→代码、查询完成→对勾、写操作→工具）。
- **交互**：每个 `.fold-head` 独立折叠，`.bullet button` 点击展开原始结果的 `<pre>`；失败时标题变「执行遇到问题」并标红、错误节点默认展开。
- **CSS 处理**：demo 的布局、层级、字号、行距、圆角、图标尺寸、折线动画全部照搬；颜色把固定色值映射到项目主题变量（`--surface / --border / --text / --text-muted / --primary / --danger`），这样深浅主题都跟得上，不会在深色模式糊一张白卡。所有选择器限定在 `.thought-card` 作用域内，不污染项目其他页面。
- 流式指令 JSON 的「实时输出」折叠区移进卡片内部，普通文本答案包在 `.thought-answer` 里留在卡片下方；`trace` 仍按 id 幂等更新并随消息持久化。

回归：`e2e_check.py` 的 `[8]`（平铺无遮罩、默认展开、自绘折线显隐、自述段落、动作行、下钻、收起/展开、答案完整）与 `[9]`（失败标红、节点默认展开、无遮罩）。

## 输入条悬空修复（布局）

现象：手机上打开 AI 页（尤其是欢迎态），输入框停在屏幕中部，下面空出一大片才到固定底栏。实测三种视口：

| 视口 | 输入条 bottom | 底栏 top | 悬空 |
|---|---|---|---|
| 390×844 | 592 | 780 | 188px |
| 430×932 | 613 | 868 | 255px |
| 1280×800 | 629 | 736 | 107px |

三个原因叠加，都是原布局公式在高屏上露馅：

1. `.ai-page` 写死 `min-height: min(620px, calc(100dvh - 220px))`，高屏上反而不够高；
2. `.ai-thread` 同时被 `max-height: min(58dvh, 520px)`（移动端 `52dvh/460px`）卡住，欢迎态内容只有 272px，聊天区撑不满；
3. `.ai-composer` 用 `position: sticky; bottom: 0`，但 sticky 只在**页面滚动时**粘底——这里页面根本不滚动，所以它老实待在 thread 后面，后面全是空白。加上 `.app-main` 的 `padding-bottom: 100/112px` 又多留了一段给底栏的余量。

**改法**：AI 页改走聊天式高度链，不动其他页面。

- `App.jsx` 在 `base === 'ai'` 时给 `<main>` 加 `app-main-chat` 类；
- 该类把 `main` 变成 flex column，`padding-bottom` 精确改为 `calc(64px + env(safe-area-inset-bottom) + 8px)`（底栏高度 + 8px 缝），不再多留 100px；
- `.page-transition` 与 `.ai-page` 依次 `flex: 1; min-height: 0`，`.ai-thread` 去掉 `max-height`、由父容器决定高度并在内部滚动；
- `.ai-composer` 用 `margin-top: auto` 落到容器底部，去掉 sticky（已经贴底，不需要滚动粘连）。

结果：390×844 / 430×932 / 1280×800 三种视口下，输入条底部距底栏顶部都稳定 **8px**，页面无多余滚动；欢迎态与已有对话态都成立。

回归：`e2e_check.py` 的 `[10]` 在两种状态 × 三种视口下断言缝隙 ≤16px、输入条在聊天区下方、`scrollHeight` 不超视口。

## 界面与流式

- **保留原版逐字流式**：`generate()` 的 `onToken` 回调照旧驱动最后一条 assistant 气泡，两轮生成（只读回灌）都带流式。普通文本走 `StreamingText`（墨水晕开动画），完成后换 `RichMarkdown`。
- 指令协议要求「整个回复是一个 JSON 对象」，流式阶段直接把 `{"reply":...` 碎片摊在气泡里会很难看，所以检测到增量以 `{` / ` ```json ` 开头时，气泡显示「正在生成操作指令…」，原始增量实时收进「实时输出」折叠区（`details.ai-output`），生成结束后再解析成 `reply` + 操作卡片。传输本身没有关掉，只是换了呈现方式。
- **确认卡片零新增 CSS**，全部复用项目内置样式：外层 `.ai-quiz-entry`（AI 出题卡片同款）、风险徽标 `.word-chip.static/.danger`、按钮组 `.ai-actions` + `.btn`、头部 `.section-head.compact` / `.setting-label` / `.tiny-note` / `.data-size`、结果区 `.ai-output` / `.ai-explain` / `.ai-error`。深浅主题自动跟随。

## 词条补录怎么落地

`public/data/index.json` / `dictionary.json` 是构建期静态资源，运行时不可写。补录写入 `localStorage` 的 `state.customWords`，加载词库时合并并派生索引条目 `{w, uk, us, p, c, b, r}`，因此搜索、详情、选中取词都能查到。随备份 JSON 一起导出导入；单文件 HTML 与 APK 同样适用。

## 本地开发

```bash
npm ci
npm run dev            # http://localhost:5173
npm run lint
npm run build:single   # dist-single/index.html
node scripts/validate-agent.mjs   # 逻辑自检
```

> 本地沙盒构建时曾把 `package-lock.json` 的 tarball 镜像临时换成 `mirrors.tencent.com/npm`（原 `registry.npmmirror.com` 在沙盒被 403 拦截）。**该改动不入库**：仓库里的 lock 文件保持原样，以免 GitHub Actions 的 `npm ci` 换源后反而失败；包版本与 integrity 全程未变。

## 已知边界

- AI 对话依赖在线服务（默认 llm7.io），离线时只有词库与已保存内容可用；写操作本身不联网。
- `generate()` 与 Android 原生桥接未改动，仍只提交 `messages`，所以用的是「提示词约定 JSON」而非 OpenAI 原生 tools 字段。
- 内置词条只读；要修正请用 `word.patch`，它会在覆盖层存一份改后的副本。
- `npm run lint` 为 0 error（项目原有 warnings 保留）。
