// 图标系统：统一走内联 sprite（24×24 / 1.75 描边 / round / currentColor）。
// 规范与 symbol 定义见 index.html 与 src/wv-ui.css。
// 常用名映射到重设计后的图标，其余沿用规范化后的 legacy 几何。
const ALIAS = {
  alert: 'alert-triangle',
  arrowRight: 'arrow-right',
  bell: 'bell',
  book: 'book',
  chart: 'chart',
  check: 'check',
  chevronDown: 'chevron-down',
  chevronRight: 'chevron-right',
  clock: 'clock',
  close: 'close',
  database: 'database',
  download: 'download',
  edit: 'pencil',
  info: 'info',
  moon: 'moon',
  pen: 'pencil',
  refresh: 'refresh',
  search: 'search',
  settings: 'settings',
  spark: 'sparkle',
  sun: 'sun',
  trash: 'trash',
  upload: 'upload',
  user: 'user',
  volume: 'volume',
}

export function Icon({ name, size = 24, className = '', strokeWidth, ...rest }) {
  const id = ALIAS[name] ? `wv-i-${ALIAS[name]}` : `wv-i-legacy-${name}`
  return (
    <svg
      className={`wv-icon ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
      {...rest}
    >
      <use href={`#${id}`} />
    </svg>
  )
}

export function LogoMark({ size = 34 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      style={{ borderRadius: 'var(--r-xs)' }}
    >
      <rect width="40" height="40" rx="6" fill="var(--primary)" />
      <path d="M8 11h4.2l3.6 12.6L19.5 11h3.8l3.7 12.6L30.6 11H35l-6.2 19h-4.1L21 18.1 17.3 30h-4.1z" fill="var(--on-primary)" />
      <rect x="8" y="33" width="24" height="2" fill="var(--on-primary)" opacity="0.65" />
    </svg>
  )
}
