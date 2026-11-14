# 02 状态管理与数据模型

## 1. 全局 Store 概览

项目没有 Redux/Zustand，唯一全局 store 是 `src/AppContext.jsx`：

```js
const [state, dispatch] = useReducer(reducer, undefined, loadState)
```

`AppProvider` 还维护两类「非持久化」状态：

| 名称 | 类型 | 作用 |
| --- | --- | --- |
| `dictStatus` | `{ indexReady, fullReady, loading, error }` | 词库加载进度，供页面显示 loading / error |
| `dictStarted` | `useRef(false)` | 防止完整词库重复预加载 |
| `stateRef` | `useRef(state)` | 保存最新 state 引用（当前未在逻辑中使用） |

对外通过 `useApp()` 暴露四个字段：

```js
{ state, dispatch, stats, dict }
```

- `state`：持久化数据。
- `dispatch`：reducer 动作分发。
- `stats`：每次渲染重新计算的派生统计。
- `dict`：词库状态与方法（`indexWords`、`lookupBasic`、`ensureFullDict` 等）。

## 2. State 结构

```js
{
  version: 1,
  profile: null | {
    nickname: string,
    identities: string[],       // 多选身份标签
    goal: string,               // GOALS.id
    level: string,              // LEVELS.id
    dailyNew: number,           // 每日新词上限
    dailyReview: number,        // 每日复习上限，0 = 不限，默认 100
    reminderTime: 'HH:mm',
    notify: boolean,
    createdAt: number
  },
  settings: {
    theme: 'system' | 'light' | 'dark',
    font: 'system' | 'serif' | 'mono' | 'custom',
    customFontName: string,
    bookId: string,             // 当前词书，如 'cet4'
    accent: 'us' | 'uk',
    autoSpeak: boolean,
    aiProviderId: string,
    aiProviders: Array<{
      id, name, base, model, key, preset?, note?
    }>
  },
  wordStates: {
    [word: string]: {
      word, status, favorite, addedAt, lastReviewedAt,
      wrongCount, correctCount, wrongFlag,
      ease, interval, reps, due, lastQuality,
      lastMode, manualAt
    }
  },
  activity: {
    'YYYY-MM-DD': {
      newWords: number, reviewWords: number,
      total: number, correct: number, minutes: number
    }
  },
  searches: Array<{ term: string, at: number }>,   // 最多 15 条
  ai: {
    chat: Array<{ role: 'user' | 'assistant', content: string }>, // 最多 40 条
    entries: {
      [word: string]: {
        example?: { text, at },
        explain?: { text, at }
      }
    }
  }
}
```

### 2.1 单词记录（wordState）

`emptyRecord(word, now)` 定义初始记录：

| 字段 | 初始值 | 含义 |
| --- | --- | --- |
| `status` | `'learning'` | 学习状态 |
| `favorite` | `false` | 是否收藏 |
| `addedAt` | `now` | 首次进入记录的时间 |
| `lastReviewedAt` | `null` | 最近作答时间 |
| `wrongCount` / `correctCount` | `0` | 累计答错 / 答对次数 |
| `wrongFlag` | `false` | 是否在错词本 |
| `ease` | `2.5` | SM-2 难度因子，最低 1.3 |
| `interval` | `0` | 当前复习间隔（天） |
| `reps` | `0` | 连续成功次数 |
| `due` | `0` | 下次到期时间戳 |
| `lastQuality` | `null` | 最近一次评分 |

状态取值与展示：

| status | 含义 | UI 文案 | 色调 |
| --- | --- | --- | --- |
| `unknown` | 完全陌生 / 答错 | 完全陌生 | danger |
| `familiar` | 不熟悉 | 不熟悉 | warning |
| `learning` | 学习中（新记录） | 学习中 | primary |
| `known` | 已掌握 | 已掌握 | success |

## 3. Reducer 动作

`reducer(state, action)` 支持以下 action：

| type | 载荷 | 行为 |
| --- | --- | --- |
| `COMPLETE_ONBOARDING` | `{ profile, bookId, settings? }` | 写入 profile，重置 settings 并设置默认词书 |
| `UPDATE_PROFILE` | `{ patch }` | 浅合并 profile |
| `UPDATE_SETTINGS` | `{ patch }` | 浅合并 settings |
| `ANSWER_WORD` | `{ word, quality, isNew, mode }` | 核心作答：SM-2 调度 + 计数 + 今日活动 + 状态机 |
| `SET_STATUS` | `{ word, status }` | 手动标记掌握程度，联动 due / wrongFlag |
| `TOGGLE_FAVORITE` | `{ word }` | 收藏切换；收藏时 `due = now` 纳入复习 |
| `ADD_SEARCH` | `{ term }` | 去重后插入搜索历史头部，保留 15 条 |
| `CLEAR_SEARCH` | — | 清空搜索历史 |
| `ADD_TIME` | `{ minutes }` | 累加今日学习时长，保留 1 位小数 |
| `AI_SET_CHAT` | `{ messages }` | 过滤非法消息，保留最近 40 条 |
| `AI_CLEAR_CHAT` | — | 清空对话 |
| `AI_SAVE_ENTRY` | `{ word, mode, text }` | 保存某词某模式的 AI 结果及时间 |
| `AI_CLEAR_ENTRY` | `{ word, mode }` | 删除某词某模式结果；空记录一并删除 |
| `IMPORT_STATE` | `{ data }` | 覆盖导入，重新规范化 settings / ai |
| `RESET_ALL` | — | 恢复默认 state（profile 变 null，回到引导页） |
| `RESET_PROGRESS` | — | 清空 wordStates / activity / searches，保留画像与设置 |

### 3.1 `ANSWER_WORD` 细节

这是学习与练习共用的核心动作，伪代码：

```js
const existed = Boolean(state.wordStates[word])
const next = state.wordStates[word] || emptyRecord(word, now)
const sm = schedule(next, quality, now)       // SM-2
const record = {
  ...next,
  ...sm,
  lastReviewedAt: now,
  wrongCount: next.wrongCount + (quality < 3 ? 1 : 0),
  correctCount: next.correctCount + (quality >= 3 ? 1 : 0),
  wrongFlag: quality < 3
    ? true
    : quality >= 4 && sm.reps >= 3
      ? false
      : next.wrongFlag,
  status: quality < 3
    ? 'unknown'
    : sm.reps >= 3 && sm.ease >= 2.3
      ? 'known'
      : next.status === 'known' ? 'known' : 'familiar',
  lastMode: mode || null,
}
```

今日活动计数规则：

| 计数 | 条件 |
| --- | --- |
| `newWords + 1` | 记录此前不存在且 `isNew === true` |
| `reviewWords + 1` | 记录此前存在，或 `isNew !== true` |
| `total + 1` | 每次作答 |
| `correct + 1` | `quality >= 3` |

> 练习页传入 `isNew: !state.wordStates[word]`，因此首次练习的单词会同时被算作「新学 + 复习」中的新学分支；Study 页显式传 `isNew` 区分新词与复习。

### 3.2 `SET_STATUS` 细节

| 目标状态 | 附加变更 |
| --- | --- |
| `known` | `wrongFlag = false`；`reps = max(3, reps)`；`interval = max(30, interval)`；`ease = max(2.5, ease)`；`due = now + 30 天` |
| `unknown` | `reps = 0`；`interval = 0`；`due = now`；`wrongFlag = true` |
| 其他（`familiar` / `learning`） | `due = now` |

同时写入 `manualAt` 记录手动操作时间。

## 4. SM-2 复习调度

实现位于 `src/lib/sm2.js`。

### 4.1 评分映射

| UI 按钮 | 常量 | quality |
| --- | --- | --- |
| 忘记 | `QUALITY.again` | 1 |
| 模糊 | `QUALITY.hard` | 3 |
| 记得 | `QUALITY.good` | 4 |
| 熟练 | `QUALITY.easy` | 5 |

练习页答错固定传 `2`，答对固定传 `4`。

### 4.2 算法公式

```js
ease = round2(max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))))
```

- `q < 3`：`reps = 0`、`interval = 0`、`due = now + 10 分钟`，允许同一会话内重试。
- `q >= 3`：
  - `reps += 1`
  - `reps === 1` → `interval = 1` 天
  - `reps === 2` → `interval = 6` 天
  - 其他 → `interval = max(1, round(interval * ease))`
  - `due = now + interval * 86400000`

辅助函数：

| 函数 | 作用 |
| --- | --- |
| `schedule(record, quality, now)` | 返回 `{ ease, interval, reps, due, lastQuality }` |
| `intervalPreview(record, quality)` | 生成「1 天 / 6 天 / 2 个月」等预览文案 |
| `nextReviewLabel(record)` | 「尚未安排 / 现在复习 / X 后复习」 |

`humanize(ms)` 的文案规则：小于 1 小时按分钟，小于 30 天按天，小于 365 天按月，否则按年。

## 5. 今日学习队列算法

学习页 `src/pages/Study.jsx` 的 `buildQueue(state, bookId)`：

```text
1. 到期复习
   due = wordStates 中 due <= now 的记录，按 due 升序
   limit = profile.dailyReview（缺省 100）
   reviewedToday = activity[today].reviewWords
   allowance = limit > 0 ? max(0, limit - reviewedToday) : due.length
   dueQueue = due.slice(0, allowance)

2. 新词
   remaining = max(0, dailyNew - activity[today].newWords)
   newWords = indexWords
     .filter(w => w.b.includes(bookId) && !wordStates[w.w])
     .sort((a, b) => (a.r || 1e9) - (b.r || 1e9) || a.w.localeCompare(b.w))
     .slice(0, remaining)
     .map(w => ({ word: w.w, isNew: true }))

3. 合并并过滤完整词库中不存在的词
   return [...dueQueue, ...newWords].filter(item => lookupFull(item.word))
```

`r` 字段是词频学习顺序：数值越小越常用。生成规则见 `scripts/apply-frequency.mjs`：

| 情况 | r |
| --- | --- |
| 词频表命中 | 词频序号 |
| 词频表未收录 | `50000 + 书中 rank` |
| 基础虚词 / 语气词 / 缩写残片 | `80000 + 书中 rank` |

`SKIP_WORDS` 会把 the / and / oh / okay 等基础词后置，避免占据学习队列前排。

## 6. 派生统计（stats）

`AppProvider` 在渲染时计算以下派生值（计数与连续天数使用 `useMemo`，其余为轻量即时计算）：

| 字段 | 计算方式 |
| --- | --- |
| `todayActivity` | `state.activity[todayKey()]`，缺省为空统计 |
| `dueCount` | `wordStates` 中 `due <= now` 的数量 |
| `masteredCount` | `status === 'known'` 的数量 |
| `wrongCount` | `wrongFlag === true` 的数量 |
| `streak` | `computeStreak(activity)`：从今天或昨天向前连续有 `total > 0` 的天数 |
| `studyDays` | `activity` 中 `total > 0` 的天数 |
| `newRemaining` | `max(0, dailyNew - todayActivity.newWords)` |
| `reviewRemaining` | `dailyReview > 0 ? max(0, dailyReview - reviewWords) : null` |
| `goal` / `level` | 从 `GOALS` / `LEVELS` 查找 |
| `currentBook` | `BOOK_MAP[settings.bookId]`，缺省 `cet4` |

日期工具在 `src/lib/date.js`：`dateKey`、`todayKey`、`startOfDay`、`addDays`、`weekDays`、`weekdayLabel`、`computeStreak`、`activeDays`、`formatMinutes`、`clockNow`。

## 7. 持久化与迁移

### 7.1 localStorage

| 键 | 内容 |
| --- | --- |
| `wordvault.state.v1` | 整个 state 的 JSON |
| `wordvault.reminder.YYYY-MM-DD` | 浏览器提醒当天已弹过的标记 |
| `wordvault-fonts`（IndexedDB 库名） | 自定义字体记录 `{ name, size, buffer }` |

`loadState()` 的容错与迁移：

1. 读取失败或 JSON 损坏 → 返回 `defaultState()`。
2. 与默认 state 浅合并，缺少的字段自动补齐。
3. `profile.dailyReview` 缺省补 `DEFAULT_DAILY_REVIEW = 100`。
4. `normalizeSettings()`：
   - 合并默认 settings；
   - `aiProviders` 为空时恢复内置提供方；
   - 兼容旧版的 `aiBase` / `aiModel` / `aiKey`，迁移到第一个 provider；
   - `aiProviderId` 不在列表中时回退到第一个。
5. `normalizeAi()`：过滤无 `role` / `content` 的消息，只保留最近 40 条；`entries` 非对象时置空。

### 7.2 导入导出

`src/lib/backup.js`：

```js
{
  app: 'WordVault',
  version: 1,
  exportedAt: 'ISO 时间',
  data: { /* 整个 state */ }
}
```

- 导出：Android 原生环境优先走 `exportBackup(filename, json)` 分享面板；否则创建 Blob + `<a download>`。
- 导入：`parseBackup(text)` 校验 `app === 'WordVault'` 且 `data.profile` 存在，然后 dispatch `IMPORT_STATE`。
- 导入会覆盖当前设备学习记录与画像，界面会二次确认。

## 8. 词库数据格式

### 8.1 文件与规模

| 文件 | 大小 | 词条数 | 用途 |
| --- | --- | --- | --- |
| `public/data/index.json` | 约 2.3 MB | 18,152 | 列表、搜索、统计、学习队列 |
| `public/data/dictionary.json` | 约 15.3 MB | 18,152 | 完整释义、例句、搭配、同反义、词族、词根 |

### 8.2 索引结构

```json
{
  "words": [
    {
      "w": "abandon",
      "uk": "ə'bænd(ə)n",
      "us": "ə'bændən",
      "p": "n",
      "c": "放任；狂热",
      "b": ["cet4", "kaoyan", "ielts", "toefl", "gaokao", "tem8", "gre", "sat", "tem4"],
      "r": 4036
    }
  ]
}
```

| 字段 | 含义 |
| --- | --- |
| `w` | 单词 |
| `uk` / `us` | 英 / 美音标 |
| `p` | 首个词性 |
| `c` | 首条中文释义 |
| `b` | 所属词书 id 列表 |
| `r` | 学习顺序（词频 rank，可选） |

### 8.3 完整词条结构

```json
{
  "source": "kajweb/dict (Youdao word books), trimmed for offline study use",
  "generatedAt": "2026-11-11",
  "books": [{ "id": "cet4", "name": "四级词汇", "short": "CET-4", "count": 3739 }],
  "words": [
    {
      "w": "abandon",
      "uk": "ə'bænd(ə)n",
      "us": "ə'bændən",
      "tr": [
        { "p": "n", "c": "放任；狂热", "e": "if someone does something with abandon, they behave in a careless or uncontrolled way, without thinking or caring about what they are doing" },
        { "p": "v", "c": "遗弃；放弃", "e": "to leave someone, especially someone you are responsible for" }
      ],
      "ex": [{ "en": "He approached life with reckless abandon–I don't think he himself knew what he was going to do next.", "cn": "他以不计后果的放纵态度对待生活–我想他自己都不知道他接下来要做什么。" }],
      "ph": [{ "en": "with abandon", "cn": "恣意地，放纵地" }, { "en": "abandon ship", "cn": "弃船" }],
      "syn": ["loose", "mania", "desert", "yield", "quit"],
      "syno": [
        { "p": "n", "t": "狂热；放任", "w": ["loose", "mania"] },
        { "p": "vt", "t": "遗弃；放弃", "w": ["desert", "yield", "quit"] }
      ],
      "ant": ["reclaim"],
      "fam": [
        { "p": "adj", "words": [{ "w": "abandoned", "t": "被抛弃的；无约束的；恣意放荡的；寡廉鲜耻的" }] },
        { "p": "n", "words": [{ "w": "abandonment", "t": "抛弃；放纵" }] },
        { "p": "v", "words": [{ "w": "abandoned", "t": "抛弃（abandon的过去式和过去分词）" }] }
      ],
      "root": "a(不)+band(乐队)+on(上)→乐队不再上台→放弃",
      "exam": [],
      "books": ["cet4", "kaoyan", "ielts", "toefl", "gaokao", "tem8", "gre", "sat", "tem4"],
      "rank": 1324,
      "star": 0
    }
  ]
}
```

字段说明：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `w` | string | 单词 |
| `uk` / `us` | string | 音标 |
| `tr` | `{p,c,e}[]` | 释义：词性、中文、英文释义 |
| `ex` | `{en,cn}[]` | 例句（最多约 2 条） |
| `ph` | `{en,cn}[]` | 常见搭配 |
| `syn` | string[] | 同义词扁平列表 |
| `syno` | `{p,t,w[]}[]` | 同义词分组 |
| `ant` | string[] | 反义词 |
| `fam` | `{p,words[{w,t}]}[]` | 同根词族 |
| `root` | string | 词根词缀 / 助记 |
| `exam` | array | 考试相关（当前多为空） |
| `books` | string[] | 所属词书 |
| `rank` | number | 词书内原始排名 |
| `star` | number | 原始星级 |

### 8.4 内置词书

`src/lib/constants.js` 的 `BOOKS` 定义 11 本词书。`dictionary.json` 中每本词书的收录数（同一词可属于多本）：

| id | 名称 | 词条数 |
| --- | --- | --- |
| `cet4` | 四级词汇 | 3,739 |
| `cet6` | 六级词汇 | 2,078 |
| `kaoyan` | 考研词汇 | 4,533 |
| `ielts` | 雅思词汇 | 3,427 |
| `toefl` | 托福词汇 | 4,263 |
| `gaokao` | 高考词汇 | 3,665 |
| `tem8` | 专八词汇 | 12,197 |
| `gre` | GRE 词汇 | 7,199 |
| `sat` | SAT 词汇 | 4,423 |
| `gmat` | GMAT 词汇 | 3,254 |
| `tem4` | 专四词汇 | 4,025 |

字段覆盖率（18,152 条中）：例句 16,156、搭配 8,659、同义词 15,865、词族 12,727、词根助记 8,755、反义词 344。

## 9. 查询、归一化与词形还原

`src/lib/dict.js`：

```js
normalize(word) = String(word).trim().toLowerCase().replace(/’/g, "'")
```

- `lookupBasic(word)`：查索引 Map。
- `lookupFull(word)`：查完整词库 Map。
- `searchWords(query, limit = 40)`：
  - 英文按「完全匹配 > 前缀 > 包含 > 子序列」打分；
  - 中文按释义匹配，前缀匹配权重大于包含；
  - 结果按分数降序、词长升序排列。
- `suggestionsFor(bookId, count = 8)`：在当前词书中等距抽样，用于查词页推荐。

`src/components/SelectionPopup.jsx` 在取词时做轻量词形还原：

| 词尾 | 还原尝试 |
| --- | --- |
| `ies` | `y` |
| `ves` | `f` |
| `es` / `s` | 去尾 |
| `ied` | `y` |
| `ed` | 去 `ed` / 去 `d` |
| `ing` | 去 `ing` / 去 `ing` + `e` |
| `est` | 去 `est` |
| `er` | 去 `er` |
| `ly` | 去 `ly` |
| 双写辅音 | 去一个重复字母（running → runn → run） |

## 10. AI 数据模型

`state.ai` 分两部分：

1. **自由对话** `chat`：`AiChat` 页使用，最多 40 条，流式生成期间只更新内存，完成后 `AI_SET_CHAT` 持久化。
2. **词条 AI 结果** `entries`：`AiAssistant` 组件使用，按 `word → mode → { text, at }` 保存「AI 例句」与「AI 精讲」，切换词条时自动恢复。

AI 配置保存在 `settings.aiProviders`，每个 provider 包含 `id / name / base / model / key`。内置 llm7.io、DeepSeek、Kilo AutoFree，用户可新增任意 OpenAI 兼容服务。

## 11. 数据安全与隐私

- 没有账号体系，不上传学习记录，不接入第三方统计。
- 在线 AI 仅在用户主动点击时请求，内容为当前词条与提示词。
- API Key 与所有配置一样存在 localStorage，导出备份时会写入 JSON 文件，需要用户自行妥善保管。
- Android 备份导出写入应用缓存目录，通过只读 `ContentProvider` 交给系统分享面板，不申请存储权限。
