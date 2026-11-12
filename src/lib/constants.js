export const BOOKS = [
  { id: 'cet4', name: '四级词汇', short: 'CET-4', desc: '大学英语四级核心词汇', color: '#4A6FA5' },
  { id: 'cet6', name: '六级词汇', short: 'CET-6', desc: '大学英语六级核心词汇', color: '#6B5B95' },
  { id: 'kaoyan', name: '考研词汇', short: '考研', desc: '考研英语大纲高频词', color: '#8A5A44' },
  { id: 'ielts', name: '雅思词汇', short: 'IELTS', desc: '雅思听说读写高频词', color: '#3E7C6B' },
  { id: 'toefl', name: '托福词汇', short: 'TOEFL', desc: '托福学术场景高频词', color: '#7A4E68' },
  { id: 'gaokao', name: '高考词汇', short: '高考', desc: '高中英语高考高频词', color: '#756A32' },
  { id: 'tem8', name: '专八词汇', short: 'TEM-8', desc: '英语专业八级高阶词汇', color: '#41597A' },
  { id: 'gre', name: 'GRE 词汇', short: 'GRE', desc: 'GRE 考试学术词汇', color: '#5C4B7D' },
  { id: 'sat', name: 'SAT 词汇', short: 'SAT', desc: 'SAT 阅读与写作核心词', color: '#356F61' },
  { id: 'gmat', name: 'GMAT 词汇', short: 'GMAT', desc: 'GMAT 商科逻辑高频词', color: '#7A4B5E' },
  { id: 'tem4', name: '专四词汇', short: 'TEM-4', desc: '英语专业四级基础词汇', color: '#6B6034' },
]

export const BOOK_MAP = Object.fromEntries(BOOKS.map((b) => [b.id, b]))

export const IDENTITIES = ['大学生', '考研党', '职场人', '高中生', '英语爱好者', '其他']

export const GOALS = [
  { id: 'cet', label: '四六级', desc: '大学英语四六级', book: 'cet4' },
  { id: 'kaoyan', label: '考研', desc: '考研英语备考', book: 'kaoyan' },
  { id: 'ielts', label: '雅思 / 托福', desc: '出国语言考试', book: 'ielts' },
  { id: 'gaokao', label: '高考', desc: '高中英语冲刺', book: 'gaokao' },
  { id: 'daily', label: '日常提升', desc: '稳步扩充词汇量', book: 'cet4' },
  { id: 'business', label: '商务英语', desc: '职场沟通与商务写作', book: 'cet6' },
]

export const LEVELS = [
  { id: 'starter', label: '入门', desc: '词汇量 < 1500', daily: 10 },
  { id: 'basic', label: '初级', desc: '词汇量 1500 - 3500', daily: 20 },
  { id: 'intermediate', label: '中级', desc: '词汇量 3500 - 6000', daily: 30 },
  { id: 'advanced', label: '高级', desc: '词汇量 6000+', daily: 50 },
]

export const DAILY_OPTIONS = [10, 20, 30, 50]

/** 每日复习上限，0 表示不限 */
export const REVIEW_OPTIONS = [
  { value: 50, label: '50', desc: '轻量' },
  { value: 100, label: '100', desc: '推荐' },
  { value: 200, label: '200', desc: '高强度' },
  { value: 0, label: '不限', desc: '全部复习' },
]

export const DEFAULT_DAILY_REVIEW = 100

export const STATUS_META = {
  unknown: { label: '完全陌生', tone: 'danger' },
  familiar: { label: '不熟悉', tone: 'warning' },
  learning: { label: '学习中', tone: 'primary' },
  known: { label: '已掌握', tone: 'success' },
}

export const FONT_OPTIONS = [
  { id: 'system', label: '系统默认', desc: '跟随设备的最优中文字体', stack: '' },
  {
    id: 'serif',
    label: '衬线阅读',
    desc: '更适合长文阅读的宋体风格',
    stack: '"Songti SC", "Noto Serif SC", "Source Han Serif SC", Georgia, serif',
  },
  {
    id: 'mono',
    label: '等宽风格',
    desc: '字母等宽，适合拼写与代码',
    stack: '"SFMono-Regular", "JetBrains Mono", "Cascadia Code", Consolas, "Noto Sans Mono CJK SC", monospace',
  },
  { id: 'custom', label: '自定义字体', desc: '上传本地字体文件，仅保存在此设备', stack: '' },
]

export const PRACTICE_MODES = [
  { id: 'choice', name: '看英选中', desc: '四选一快速辨义', icon: 'list' },
  { id: 'listening', name: '听音辨词', desc: '听发音选拼写', icon: 'volume' },
  { id: 'spelling', name: '拼写测试', desc: '根据释义输入单词', icon: 'keyboard' },
  { id: 'cloze', name: '选词填空', desc: '在例句中还原单词', icon: 'pen' },
]

export const SOURCE_NOTE = '本地词库整理自开源项目 kajweb/dict（有道词书数据），经裁剪后随应用离线分发。'

/** 内置 AI 提供方，用户也可以自行添加 */
export const AI_PROVIDERS = [
  {
    id: 'llm7',
    name: 'llm7.io',
    base: 'https://api.llm7.io/v1',
    model: 'codestral-latest',
    key: '',
    preset: true,
    note: '免费 · 无需 Key · 支持跨域',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    base: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    key: '',
    preset: true,
    note: '需填写 API Key',
  },
  {
    id: 'kilo',
    name: 'Kilo AutoFree',
    base: 'https://ai-gateway.kilo.ai/api/v1',
    model: 'kilo-auto/free',
    key: '',
    preset: true,
    note: '免费 · 浏览器需代理',
  },
]

export function activeAiProvider(settings) {
  const list = settings?.aiProviders?.length ? settings.aiProviders : AI_PROVIDERS
  return list.find((item) => item.id === settings?.aiProviderId) || list[0]
}
