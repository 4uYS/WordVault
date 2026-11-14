import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
const { validateActions } = await server.ssrLoadModule('/src/lib/agentTools.js')

const W = 'pneumonoultramicroscopicsilicovolcanoconiosis'
const cases = [
  {
    name: '模型常见写法①：confirm 没写「不可撤销」',
    actions: [{
      tool: 'word.upsert',
      args: {
        word: W,
        entry: { w: W, uk: '', us: '', tr: [{ p: 'n', c: '尘肺病', e: '' }], ex: [], books: ['cet4'] },
      },
      reason: '词库未收录', confirm: `将把 ${W} 加入四级词汇`,
    }],
  },
  {
    name: '模型常见写法②：entry 省略 w',
    actions: [{
      tool: 'word.upsert',
      args: { word: W, entry: { tr: [{ p: 'n', c: '尘肺病' }], books: ['cet4'] } },
      reason: '词库未收录', confirm: '不可撤销地写入本机词库',
    }],
  },
  {
    name: '模型常见写法③：用 c/p 简写代替 tr（索引结构）',
    actions: [{
      tool: 'word.upsert',
      args: { word: W, entry: { w: W, c: '尘肺病', p: 'n', b: ['cet4'] } },
      reason: '词库未收录', confirm: '不可撤销地补录',
    }],
  },
  {
    name: '模型常见写法④：books 写成中文词书名',
    actions: [{
      tool: 'word.upsert',
      args: { word: W, entry: { w: W, tr: [{ p: 'n', c: '尘肺病' }], books: ['四级词汇'] } },
      reason: '词库未收录', confirm: '不可撤销地补录',
    }],
  },
  {
    name: '严格合规写法（对照组）',
    actions: [{
      tool: 'word.upsert',
      args: {
        word: W,
        entry: {
          w: W, uk: '', us: '', tr: [{ p: 'n', c: '尘肺病', e: '' }],
          ex: [{ en: 'He was diagnosed with pneumonoultramicroscopicsilicovolcanoconiosis.', cn: '他被诊断出尘肺病。' }],
          ph: [], syn: [], syno: [], ant: [], fam: [], root: '', exam: [],
          books: ['cet4'], rank: 0, star: 0,
        },
      },
      reason: '词库未收录', confirm: `将把 ${W} 加入四级词汇（不可撤销地写入本机自定义词库）`,
    }],
  },
]

for (const c of cases) {
  const r = validateActions(c.actions)
  console.log(`${r.ok ? '通过' : '拦截'} | ${c.name}${r.ok ? '' : ' → ' + r.error}`)
}
await server.close()
