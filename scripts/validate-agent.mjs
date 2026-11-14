import { createServer } from 'vite'

// 让 speechLong 走 Web Speech 排队分支，便于统计 cancel / speak 次数
const spoken = []
let cancels = 0
class FakeUtterance {
  constructor(text) { this.text = text }
}
globalThis.SpeechSynthesisUtterance = FakeUtterance
globalThis.window = {
  SpeechSynthesisUtterance: FakeUtterance,
  speechSynthesis: {
    getVoices: () => [{ lang: 'en-US' }],
    cancel: () => { cancels += 1 },
    speak: (utter) => spoken.push(utter.text),
  },
}

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
const llm = await server.ssrLoadModule('/src/lib/llm.js')
const tools = await server.ssrLoadModule('/src/lib/agentTools.js')
const dict = await server.ssrLoadModule('/src/lib/dict.js')
const app = await server.ssrLoadModule('/src/AppContext.jsx')

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`) }
}

console.log('\n[1] 提示词与解析')
ok('AGENT_SYSTEM 含工具清单', llm.AGENT_SYSTEM.includes('L3 · 高敏写入') && llm.AGENT_SYSTEM.includes('word.upsert'))
ok('LOOKUP_SYSTEM 含标准词条结构', llm.LOOKUP_SYSTEM.includes('"rank": 0'))
const agentJson = JSON.stringify({
  reply: '已为你准备好，请确认。',
  actions: [{ tool: 'stats.get', args: {}, reason: '查询统计', confirm: '' }],
})
ok('合法指令解析为 agent', llm.parseAgentReply(agentJson).kind === 'agent')
ok('纯文本解析为 plain', llm.parseAgentReply('affect 是动词，effect 多为名词。').kind === 'plain')
ok('代码块围栏可容错', llm.parseAgentReply('```json\n' + agentJson + '\n```').kind === 'agent')
const mixed = llm.parseAgentReply('全文超过单次朗读上限，已按三段拆好，将依次播放：\n\n' + agentJson)
ok('中文前缀 + JSON 仍能提取指令', mixed.kind === 'agent', JSON.stringify(mixed).slice(0, 120))
ok('夹带文字记入 stray 不混入 reply', mixed.reply === '已为你准备好，请确认。' && mixed.stray.includes('三段'))
ok('尾部附加文字也能提取', llm.parseAgentReply(agentJson + '\n以上请确认').kind === 'agent')
ok('普通 JSON 片段不误判为写操作', llm.parseAgentReply('示例：{"question":"x","answer":0}').kind === 'plain')
ok('截断的不完整 JSON 不误判', llm.parseAgentReply('{"reply":"hi","actions":[').kind === 'plain')
ok('嵌套对象括号配对正确', llm.parseAgentReply('前缀 ' + JSON.stringify({
  reply: 'r', actions: [{ tool: 'speech.speak', args: { text: '{"a":1}' }, confirm: '' }],
})).actions[0].args.text === '{"a":1}')
ok('buildLookupMessages 使用补录提示词', llm.buildLookupMessages('[上下文]\nfound: false\n[/上下文]')[0].content === llm.LOOKUP_SYSTEM)
ok('buildChatMessages 使用 Agent 提示词', llm.buildChatMessages([], 'hi')[0].content === llm.AGENT_SYSTEM)

console.log('\n[2] 工具注册表与参数校验')
ok('注册 44 个工具', Object.keys(tools.TOOL_REGISTRY).length === 44, `实际 ${Object.keys(tools.TOOL_REGISTRY).length}`)
const V = tools.validateActions
ok('L0 带 confirm 被拦截', !V([{ tool: 'stats.get', args: {}, confirm: '确认' }]).ok)
ok('未知工具被拦截', !V([{ tool: 'reset.all', args: {}, confirm: '确认' }]).ok)
ok('多余参数被拦截', !V([{ tool: 'dict.lookup', args: { word: 'abandon', key: 'x' }, confirm: '' }]).ok)
const l3Soft = V([{ tool: 'word.removeCustom', args: { word: 'foo' }, confirm: '删除词条' }])
ok('L3 确认文案缺关键字由宿主补齐', l3Soft.ok && /不可撤销/.test(l3Soft.actions[0].confirm), l3Soft.error)
ok('改 API 提供方配置被拦截', !V([{ tool: 'settings.update', args: { patch: { aiProviders: [] } }, confirm: '修改' }]).ok)
ok('伪造学习时长字段被拦截', !V([{ tool: 'profile.update', args: { patch: { activity: {} } }, confirm: '修改' }]).ok)
ok('批量超 20 被拦截', !V([{ tool: 'word.batchStatus', args: { words: Array(21).fill('word'), status: 'known' }, confirm: '批量' }]).ok)
ok('重复动作被拦截', !V([
  { tool: 'search.clear', args: {}, confirm: '清空' },
  { tool: 'search.clear', args: {}, confirm: '清空' },
]).ok)
const entry = {
  w: 'quixotic', uk: '', us: '', tr: [{ p: 'adj', c: '不切实际的', e: '' }],
  ex: [{ en: 'A quixotic plan.', cn: '不切实际的计划。' }],
  ph: [], syn: [], syno: [], ant: [], fam: [], root: '', exam: [], books: ['gre'], rank: 0, star: 0,
}
const upsert = V([{ tool: 'word.upsert', args: { word: 'quixotic', entry }, reason: '词库缺失', confirm: '将把 quixotic 加入 GRE 词汇（不可撤销）' }])
ok('合法补录指令通过', upsert.ok, upsert.error)
const badBook = V([{ tool: 'word.upsert', args: { word: 'quixotic', entry: { ...entry, books: ['hack'] } }, confirm: '不可撤销' }])
ok('非法词书 id 归一化为当前词书', badBook.ok && badBook.actions[0].args.entry.books[0] === 'cet4', badBook.error)
ok('L0 只读指令自动通过', V([{ tool: 'stats.get', args: {}, confirm: '', reason: '' }]).actions[0].risk === 'L0')

console.log('\n[2b] 补录指令容错（本次 bug 回归）')
const W = 'pneumonoultramicroscopicsilicovolcanoconiosis'
const loose = (word, entry, confirm) => V([{ tool: 'word.upsert', args: { word, entry }, reason: '词库缺失', confirm }], { currentBookId: 'gre' })
const c1 = loose(W, { w: W, tr: [{ p: 'n', c: '尘肺病' }], books: ['gre'] }, `将把 ${W} 加入 GRE 词汇`)
ok('①confirm 漏关键字仍能出确认卡片', c1.ok && /不可撤销/.test(c1.actions[0].confirm), c1.error)
const c2 = loose(W, { tr: [{ p: 'n', c: '尘肺病' }], books: ['gre'] }, '不可撤销地补录')
ok('②entry 省略 w 自动补齐', c2.ok && c2.actions[0].args.entry.w === W, c2.error)
const c3 = loose(W, { w: W, c: '尘肺病', p: 'n', b: ['gre'] }, '不可撤销地补录')
ok('③c/p 简写派生出 tr', c3.ok && c3.actions[0].args.entry.tr[0].c === '尘肺病', c3.error)
const c4 = loose(W, { w: W, tr: [{ p: 'n', c: '尘肺病' }], books: ['四级词汇'] }, '不可撤销地补录')
ok('④中文词书名映射为合法 id', c4.ok && c4.actions[0].args.entry.books[0] === 'cet4', c4.error)
const c5 = loose(W, { w: W, tr: [{ p: 'n', c: '尘肺病' }] }, '不可撤销地补录')
ok('⑤books 缺失回退当前词书', c5.ok && c5.actions[0].args.entry.books[0] === 'gre', c5.error)
ok('归一化后补齐全部标准字段', ['w', 'uk', 'us', 'tr', 'ex', 'ph', 'books', 'rank', 'star'].every((k) => k in c5.actions[0].args.entry))
const c6 = loose(W, { w: W }, '不可撤销地补录')
ok('⑥完全没给释义才拒绝', !c6.ok && /释义/.test(c6.error), c6.error)
ok('安全边界仍生效：未知工具被拦', !V([{ tool: 'reset.all', args: {}, confirm: '不可撤销' }]).ok)

console.log('\n[2c] 长文朗读（本次 bug 回归）')
const speechCtx = {
  state: { settings: { accent: 'us' } },
  dispatch: () => {}, stats: {}, dict: {}, ui: {}, provider: {},
}
const article = [
  'Every morning, I learn five new words. Not fifty—just five.',
  'I read them aloud, write one sentence for each, and let them rest until evening.',
  'Small steps feel slow, but they add up. After a year, that is over eighteen hundred words.',
  'Learning a language is not a race. It is a quiet conversation with yourself, repeated every day.',
].join(' ')
const oneShot = V([{ tool: 'speech.speak', args: { text: article, accent: 'us', rate: 0.9 }, confirm: '' }])
ok('单次长文不再被 200 字符上限拦截', oneShot.ok, oneShot.error)
spoken.length = 0
cancels = 0
const execSpeech = await tools.executeTools(oneShot.actions, speechCtx)
ok('长文自动分片入队', spoken.length >= 2, `片段数 ${spoken.length}`)
ok('只 cancel 一次（不互相打断）', cancels === 1, `cancel ${cancels}`)
ok('每段不超过 200 字符', spoken.every((s) => s.length <= 200), spoken.map((s) => s.length).join(','))
ok('分片覆盖全文开头', spoken.join(' ').includes('Every morning'))
ok('执行器回显分段数', /自动分成/.test(execSpeech.results[0]), execSpeech.results[0])
ok('执行无异常', execSpeech.errors.length === 0, JSON.stringify(execSpeech.errors))

const three = V([
  { tool: 'speech.speak', args: { text: article.slice(0, 110), accent: 'us', rate: 0.9 }, confirm: '' },
  { tool: 'speech.speak', args: { text: article.slice(110, 220), accent: 'us', rate: 0.9 }, confirm: '' },
  { tool: 'speech.speak', args: { text: article.slice(220), accent: 'us', rate: 0.9 }, confirm: '' },
])
ok('模型拆成 3 个朗读动作也通过', three.ok, three.error)
spoken.length = 0
cancels = 0
await tools.executeTools(three.actions, speechCtx)
ok('连续朗读动作合并后只 cancel 一次', cancels === 1, `cancel ${cancels}`)
ok('合并后按句重新分片', spoken.length >= 2, `片段数 ${spoken.length}`)

console.log('\n[3] 词条清洗与覆盖层')
const clean = app.sanitizeEntry('QUIXOTIC', { ...entry, evilKey: 'x', tr: [{ p: 'adj', c: '不切实际的' }] })
ok('词形统一小写', clean.w === 'quixotic')
ok('非法字段被丢弃', !('evilKey' in clean))
ok('词书白名单生效', JSON.stringify(clean.books) === '["gre"]')
ok('派生字段齐全', ['uk', 'us', 'tr', 'ex', 'ph', 'books', 'rank', 'star'].every((k) => k in clean))
dict.setCustomWords({ quixotic: clean })
ok('覆盖层词条可被 lookupFull 查到', dict.lookupFull('quixotic')?.tr?.[0]?.c === '不切实际的')
ok('覆盖层词条可被 searchWords 搜到', dict.searchWords('quixotic', 10).some((w) => w.w === 'quixotic'))
ok('覆盖层词条可被 lookupBasic 查到', dict.lookupBasic('quixotic')?.c === '不切实际的')
ok('dictionary.stats 统计自定义词条', dict.dictionaryStats().custom === 1)
ok('isCustomWord 正确识别', dict.isCustomWord('quixotic') && !dict.isCustomWord('abandon'))

console.log('\n[4] 执行器（mock 宿主）')
const dispatches = []
const mockState = {
  settings: { bookId: 'cet4', theme: 'light', accent: 'us', aiProviders: [{ id: 'demo', name: 'Demo', model: 'm', key: 'TOP_SECRET' }] },
  profile: { nickname: '词库旅人', dailyNew: 20 },
  wordStates: { abandon: { status: 'learning', wrongFlag: true, wrongCount: 3 } },
  searches: [{ term: 'abandon' }],
  ai: { chat: [], entries: {} },
  customWords: {},
}
const ctx = {
  state: mockState,
  dispatch: (a) => dispatches.push(a),
  stats: { dueCount: 7, masteredCount: 20, wrongCount: 1, todayActivity: { newWords: 3 } },
  dict: { indexReady: true, fullReady: true },
  ui: { navigate: () => {}, openWord: () => {}, showToast: () => {} },
  provider: {},
}
const execRead = await tools.executeTools(V([
  { tool: 'stats.get', args: {}, confirm: '', reason: '' },
  { tool: 'ai.provider.list', args: {}, confirm: '', reason: '' },
  { tool: 'wrongbook.list', args: { limit: 5 }, confirm: '', reason: '' },
  { tool: 'word.get', args: { word: 'abandon' }, confirm: '', reason: '' },
]).actions, ctx)
ok('只读工具全部执行成功', execRead.errors.length === 0, JSON.stringify(execRead.errors))
ok('统计结果含真实数值', execRead.results[0].includes('"dueCount":7'))
ok('提供方列表不泄露 Key', !execRead.results[1].includes('TOP_SECRET') && execRead.results[1].includes('hasKey'))
ok('错词本读到目标词', execRead.results[2].includes('abandon'))

const execWrite = await tools.executeTools(V([
  { tool: 'profile.update', args: { patch: { nickname: '小词' } }, confirm: '把昵称改为小词' },
  { tool: 'book.switch', args: { bookId: 'gre' }, confirm: '切换到 GRE 词汇' },
]).actions, ctx)
ok('写工具 dispatch 正确', dispatches.some((d) => d.type === 'UPDATE_PROFILE' && d.patch.nickname === '小词'))
ok('切换词书 dispatch 正确', dispatches.some((d) => d.type === 'UPDATE_SETTINGS' && d.patch.bookId === 'gre'))
ok('写工具无异常', execWrite.errors.length === 0)

const execL3 = await tools.executeTools(V([{
  tool: 'word.upsert', args: { word: 'quixotic', entry }, reason: '词库缺失', confirm: '不可撤销地写入本机自定义词库',
}]).actions, ctx)
ok('补录落到 CUSTOM_WORD_UPSERT', dispatches.some((d) => d.type === 'CUSTOM_WORD_UPSERT' && d.word === 'quixotic'))
ok('补录执行无异常', execL3.errors.length === 0, JSON.stringify(execL3.errors))

console.log('\n[5] 上下文脱敏')
const block = tools.buildContextBlock(mockState, ctx.stats, ctx.dict)
ok('上下文含当前词书', block.includes('currentBookId: cet4'))
ok('上下文含合法词书清单', block.includes('validBookIds:'))
ok('上下文不含任何 Key', !block.includes('TOP_SECRET'))
const lookupBlock = tools.buildLookupContextBlock('quixotic', mockState, ctx.dict)
ok('补录上下文含 found 字段', lookupBlock.includes('found:'))

await server.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
