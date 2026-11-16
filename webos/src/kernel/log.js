/* Kernel ring buffer: dmesg, audit trail and rate-limited diagnostics. */

const LEVELS = ['emerg', 'alert', 'crit', 'err', 'warn', 'notice', 'info', 'debug'];
const LEVEL_NUM = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
const FACILITIES = { kern: 0, user: 1, daemon: 3, auth: 4, syslog: 5 };

/**
 * A bounded kernel log. Messages are kept in memory and exposed through
 * /dev/kmsg, /proc/kmsg and `dmesg`. Nothing is printed to the host console.
 */
export class KernelLog {
  constructor(kernel, limit = 2048) {
    this.kernel = kernel;
    this.limit = limit;
    this.entries = [];
    this.seq = 0;
    this.dropped = 0;
    this.listeners = new Set();
    this.minLevel = 'debug';
  }

  stamp(entry) {
    const sec = Math.max(0, (entry.time - this.kernel.bootTime) / 1000);
    return sec.toFixed(6).padStart(11, ' ');
  }

  write(level, message, facility = 'kern') {
    const lvl = LEVEL_NUM[level] != null ? level : 'info';
    const entry = {
      seq: ++this.seq,
      time: Date.now(),
      level: lvl,
      facility,
      message: String(message).replace(/\n$/, ''),
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
      this.dropped++;
    }
    for (const fn of this.listeners) {
      try { fn(entry); } catch { /* listeners must not break logging */ }
    }
    return entry;
  }

  debug(msg, fac) { return this.write('debug', msg, fac); }
  info(msg, fac) { return this.write('info', msg, fac); }
  notice(msg, fac) { return this.write('notice', msg, fac); }
  warn(msg, fac) { return this.write('warn', msg, fac); }
  err(msg, fac) { return this.write('err', msg, fac); }

  audit(action, detail = '') {
    return this.write('notice', `audit: ${action}${detail ? ` ${detail}` : ''}`, 'auth');
  }

  /** Entries at or above `level`, optionally only newer than `sinceSeq`. */
  query({ level = 'debug', since = 0 } = {}) {
    const max = LEVEL_NUM[level] ?? 7;
    return this.entries.filter((e) => e.seq > since && LEVEL_NUM[e.level] <= max);
  }

  /** dmesg-style text with buffer-relative timestamps. */
  text({ level = 'debug', since = 0 } = {}) {
    return this.query({ level, since }).map((e) =>
      `[${this.stamp(e)}] ${e.facility}.${e.level}: ${e.message}`).join('\n') + (this.seq ? '\n' : '');
  }

  kmsgText({ since = 0 } = {}) {
    return this.entries.filter((e) => e.seq > since).map((e) =>
      `${e.seq},${e.time},${FACILITIES[e.facility] ?? 0},${LEVEL_NUM[e.level]};${e.message}\n`).join('');
  }

  clear() {
    this.entries = [];
    this.dropped = 0;
  }
}

export { LEVELS, LEVEL_NUM };
