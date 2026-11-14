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
