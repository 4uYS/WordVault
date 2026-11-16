/* System inspection, user/group management, job control and misc utilities. */

import { parseOpts, resolvePath, readTextFile, errnoText, humanSize, pad, fmtDate, parseSize } from './util.js';
import { SIGNALS, signalName } from '../kernel/process.js';

const REL = '6.6.0-webos';
const MACHINE = (() => {
  const ua = String(globalThis.navigator?.userAgent || '').toLowerCase();
  if (/aarch64|arm64/.test(ua)) return 'aarch64';
  if (/arm/.test(ua)) return 'armv7l';
  return 'x86_64';
})();
const NCPU = Math.max(1, globalThis.navigator?.hardwareConcurrency || 4);
const enc = new TextEncoder();
const dec = new TextDecoder();

function reg(ctx, name, summary, run) {
  ctx.kernel.registerCommand(name, { summary, run });
}

function reportErr(c, msg, code = 1) {
  c.err(msg + '\n');
  return code;
}

const isRoot = (c) => c.uid === 0;
const userName = (kernel, uid) => kernel.userByUid(uid)?.name || String(uid);
const groupName = (kernel, gid) => kernel.groupByGid(gid)?.name || String(gid);
const quote = (s) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, "'\\''")}'`);

function etcText(c, path, fallback = '') {
  try { return readTextFile(c, path); } catch { return fallback; }
}

function writeEtc(c, path, text, mode) {
  c.vfs.writeFile(path, text, { uid: 0, gid: 0, cwd: '/' }, { mode: mode || 0o644 });
  try { c.vfs.chmod(path, mode || 0o644, { uid: 0, gid: 0 }); } catch { /* ignore */ }
}

function syncPasswd(kernel, c) {
  writeEtc(c, '/etc/passwd', kernel.users.map((u) =>
    `${u.name}:x:${u.uid}:${u.gid}:${u.gecos || u.name}:${u.home}:${u.shell || '/bin/sh'}`).join('\n') + '\n');
}

function syncGroup(kernel, c) {
  writeEtc(c, '/etc/group', kernel.groups.map((g) =>
    `${g.name}:x:${g.gid}:${(g.members || []).join(',')}`).join('\n') + '\n');
}

function syncShadow(kernel, c) {
  const old = new Map(etcText(c, '/etc/shadow').split('\n').filter(Boolean).map((l) => {
    const f = l.split(':');
    return [f[0], l];
  }));
  const lines = kernel.users.map((u) => old.get(u.name) || `${u.name}:!*:19000:0:99999:7:::`);
  writeEtc(c, '/etc/shadow', lines.join('\n') + '\n', 0o640);
}

function parseStatLines(c, path) {
  return etcText(c, path).split('\n').filter(Boolean).map((l) => l.split(':'));
}

function groupsOf(kernel, user) {
  return [...new Set([user.gid, ...kernel.groups.filter((g) => g.members?.includes(user.name)).map((g) => g.gid)])];
}

function z2(n) { return String(n).padStart(2, '0'); }

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} day${d === 1 ? '' : 's'}, ${h}:${z2(m)}`;
  return `${h}:${z2(m)}`;
}

function fmtUptimePretty(sec) {
  sec = Math.max(0, Math.floor(sec));
  const parts = [];
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) parts.push(`${d} day${d === 1 ? '' : 's'}`);
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m || !parts.length) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  return 'up ' + parts.join(', ');
}

function fmtTime(ms) { return new Date(ms).toISOString().slice(11, 19); }

function procTime(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 3600)}:${z2(Math.floor((s % 3600) / 60))}:${z2(s % 60)}`;
}

function procElapsed(p) {
  const s = Math.floor((Date.now() - p.started) / 1000);
  return `${Math.floor(s / 86400)}-${z2(Math.floor((s % 86400) / 3600))}:${z2(Math.floor((s % 3600) / 60))}:${z2(s % 60)}`;
}

function stateOf(p) {
  if (p.state === 'Z') return 'Z';
  if (p.state === 'T') return 'T';
  if (p.state === 'R') return 'R';
  return 'S';
}

function procArgs(p) { return (p.argv && p.argv.length ? p.argv.join(' ') : p.name); }

function parsePidList(v) {
  if (v == null) return null;
  return String(v).split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n));
}

function userMatches(kernel, c, p, spec) {
  if (spec == null) return true;
  const u = kernel.userByUid(p.uid);
  return u ? u.name === spec || String(p.uid) === String(spec) : String(p.uid) === String(spec);
}

function table(rows, headers, right = []) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmtRow = (r) => r.map((v, i) => (right.includes(i) ? pad(v, widths[i], true) : pad(v, widths[i]))).join(' ').replace(/\s+$/, '');
  return [fmtHeader(headers, widths), ...rows.map(fmtRow)].join('\n') + '\n';
}

function fmtHeader(headers, widths) {
  return headers.map((h, i) => pad(h, widths[i])).join(' ').replace(/\s+$/, '');
}

/* Run a shell as another user (credential switch where the sandbox allows it). */
function spawnAs(c, user, src) {
  const sh = c.shell.clone();
  sh.uid = user.uid;
  sh.gid = user.gid;
  sh.groups = groupsOf(c.kernel, user);
  sh.home = user.home;
  sh.cwd = user.home;
  sh.vars.set('HOME', user.home);
  sh.vars.set('USER', user.name);
  sh.vars.set('LOGNAME', user.name);
  sh.exports.add('HOME'); sh.exports.add('USER'); sh.exports.add('LOGNAME');
  return sh.startSession(src, { stdin: c.stdin, stdout: c.stdout, stderr: c.stderr });
}

function signalArgs(argv) {
  const rest = [];
  let sig = null;
  for (const a of argv) {
    if (/^-(SIG)?[A-Za-z0-9]+$/.test(a) && a !== '-f' && a !== '-x' && a !== '-u' && a !== '-n' && a !== '-o' && a !== '-s'
      && a !== '-l' && a !== '-e' && a !== '-q' && a !== '-w' && a !== '-I' && a !== '-v') {
      if (/^-(\d+|SIG[A-Z]+)$/i.test(a)) { sig = a.slice(1).toUpperCase().replace(/^SIG/, ''); continue; }
    }
    rest.push(a);
  }
  return { sig, rest };
}

function matchProcs(kernel, c, pattern, o) {
  let list = [...kernel.procs.values()];
  if (o.u) list = list.filter((p) => userMatches(kernel, c, p, o.u));
  if (pattern != null) {
    const exact = !!o.x;
    const full = !!o.f;
    const re = (() => { try { return new RegExp(pattern); } catch { return null; } })();
    list = list.filter((p) => {
      const hay = full ? procArgs(p) : p.name;
      if (exact) return hay === pattern || (!full && p.name === pattern);
      if (re && re.test(hay)) return true;
      return hay.includes(pattern);
    });
  }
  list.sort((a, b) => a.pid - b.pid);
  if (o.n) list = list.slice(-1);
  if (o.o) list = list.slice(0, 1);
  return list;
}

/* ------------------------------ registration ------------------------------ */

export function registerSystemCommands(kernel) {
  const ctx = { kernel };

  /* ------------------------------ ps ------------------------------ */
  reg(ctx, 'ps', 'report a snapshot of the current processes', async (c) => {
    const o = parseOpts(c.args, 'eAfaup:o:', {
      forest: 'forest', user: 'u:', 'no-headers': 'noheaders', pid: 'p:', format: 'o:',
    });
    const fields = (o.o || (o.f ? 'uid,pid,ppid,c,stime,tty,time,cmd' : 'pid,tty,time,cmd'))
      .split(/[,\s]+/).filter(Boolean);
    let list = [...kernel.procs.values()];
    const pids = parsePidList(o.p);
    if (pids) list = list.filter((p) => pids.includes(p.pid));
    if (o.u) list = list.filter((p) => userMatches(kernel, c, p, o.u));
    list.sort((a, b) => a.pid - b.pid);

    const depth = new Map();
    if (o.forest) {
      const kids = new Map();
      for (const p of list) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
      const out = [];
      const walk = (pid, d) => {
        for (const p of (kids.get(pid) || []).sort((a, b) => a.pid - b.pid)) {
          out.push(p); depth.set(p.pid, d); walk(p.pid, d + 1);
        }
      };
      const pidsIn = new Set(list.map((p) => p.pid));
      for (const p of list) if (!pidsIn.has(p.ppid)) walk(p.ppid, 0);
      for (const p of list) if (!out.includes(p)) out.push(p);
      list = out;
    }

    const val = (p, f) => {
      switch (f) {
        case 'pid': return String(p.pid);
        case 'ppid': return String(p.ppid);
        case 'user': case 'uid': return o.f ? userName(kernel, p.uid) : userName(kernel, p.uid);
        case 'gid': return String(p.gid);
        case 'c': return String(Math.min(99, Math.floor((p.cpu || 0) / 1000)));
        case 'stime': return fmtTime(p.started).slice(0, 5);
        case 'tty': return p.tty ? p.tty.replace('/dev/', '').slice(0, 8) : '?';
        case 'time': return procTime(p.cpu);
        case 'etime': return procElapsed(p);
        case 'cmd': return (o.forest ? '  '.repeat(depth.get(p.pid) || 0) : '') + procArgs(p);
        case 'comm': return p.name;
        case 'args': return procArgs(p);
        case 'stat': return stateOf(p) + (p.pid === 1 ? 's' : '');
        case '%cpu': return ((p.cpu || 0) / 1000).toFixed(1);
        case '%mem': {
          const m = kernel.memoryInfo();
          return ((4096 + (p.cpu || 0) / 100) / m.total * 100).toFixed(1);
        }
        case 'nice': case 'ni': return String(p.nice ?? 0);
        case 'pri': return String(20 + (p.nice ?? 0));
        default: return '';
      }
    };
    const headers = fields.map((f) => ({
      pid: 'PID', ppid: 'PPID', user: 'USER', uid: 'UID', gid: 'GID', c: 'C', stime: 'STIME', tty: 'TTY',
      time: 'TIME', etime: 'ELAPSED', cmd: 'CMD', comm: 'COMMAND', args: 'CMD', stat: 'STAT',
      '%cpu': '%CPU', '%mem': '%MEM', nice: 'NI', ni: 'NI', pri: 'PRI',
    }[f] || f.toUpperCase()));
    const rows = list.map((p) => fields.map((f) => val(p, f)));
    if (!o.noheaders) c.out(table(rows, headers));
    else c.out(rows.map((r) => r.join(' ')).join('\n') + (rows.length ? '\n' : ''));
    return 0;
  });

  /* ------------------------------ pstree ------------------------------ */
  reg(ctx, 'pstree', 'display a tree of processes', async (c) => {
    const o = parseOpts(c.args, 'pa');
    const showPids = !!o.p, showArgs = !!o.a;
    const list = [...kernel.procs.values()];
    const kids = new Map();
    for (const p of list) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
    const label = (p) => showArgs ? procArgs(p) : p.name;
    const lines = [];
    const walk = (pid, prefix, isLast, isRootNode) => {
      const children = (kids.get(pid) || []).sort((a, b) => a.pid - b.pid);
      children.forEach((p, i) => {
        const last = i === children.length - 1;
        const branch = isRootNode ? '' : (last ? '`-- ' : '|-- ');
        lines.push(prefix + branch + label(p) + (showPids ? `(${p.pid})` : ''));
        walk(p.pid, prefix + (isRootNode ? '' : (last ? '    ' : '|   ')), last, false);
      });
    };
    const roots = (kids.get(0) || []).sort((a, b) => a.pid - b.pid);
    for (let i = 0; i < roots.length; i++) {
      const p = roots[i];
      lines.push(label(p) + (showPids ? `(${p.pid})` : ''));
      walk(p.pid, '', i === roots.length - 1, false);
    }
    if (!o._.length) {
      for (const l of lines) c.out(l + '\n');
      return 0;
    }
    const re = new RegExp(o._[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    for (const l of lines) if (re.test(l) || /^\S/.test(l)) c.out(l + '\n');
    return 0;
  });

  /* ------------------------------ top ------------------------------ */
  let topSeq = 0;
  reg(ctx, 'top', 'display dynamic real-time process information (batch)', async (c) => {
    const o = parseOpts(c.args, 'bn:d:p:', { batch: 'b', iterations: 'n:', delay: 'd:', pid: 'p:' });
    const iterations = Math.max(1, Math.min(20, Number(o.n || 1) || 1));
    const delay = Number(o.d || 0) || 0;
    const pids = parsePidList(o.p);
    for (let it = 0; it < iterations; it++) {
      topSeq++;
      const m = kernel.memoryInfo();
      const procs = [...kernel.procs.values()];
      const zombie = procs.filter((p) => p.state === 'Z').length;
      const running = procs.filter((p) => p.state === 'R').length;
      const sleeping = procs.length - running - zombie;
      const up = kernel.uptime;
      const now = new Date();
      c.out(`top - ${now.toISOString().slice(11, 19)} up ${fmtDuration(up)},  1 user,  load average: ${(up / 3600).toFixed(2)}, ${(up / 7200).toFixed(2)}, ${(up / 14400).toFixed(2)}\n`);
      c.out(`Tasks: ${pad(procs.length, 3, true)} total, ${pad(running, 3, true)} running, ${pad(sleeping, 3, true)} sleeping, ${pad(0, 3, true)} stopped, ${pad(zombie, 3, true)} zombie\n`);
      c.out(`%Cpu(s):  ${((topSeq % 7) * 0.7).toFixed(1)} us,  ${((topSeq % 3) * 0.3).toFixed(1)} sy,  0.0 ni, ${(96 - (topSeq % 5)).toFixed(1)} id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st\n`);
      c.out(`MiB Mem : ${(m.total / 1048576).toFixed(1)} total, ${(m.free / 1048576).toFixed(1)} free, ${(m.used / 1048576).toFixed(1)} used, ${(m.free / 1048576).toFixed(1)} buff/cache\n`);
      c.out(`MiB Swap:      0.0 total,      0.0 free,      0.0 used. ${(m.free / 1048576).toFixed(1)} avail Mem\n\n`);
      c.out('    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n');
      let list = procs.filter((p) => !pids || pids.includes(p.pid));
      const rows = list.map((p) => {
        const cpu = ((p.pid * 13 + topSeq * 17) % 400) / 10;
        const rss = 4096 + (p.cpu || 0) / 100;
        return { p, cpu, rss, mem: rss / m.total * 100 };
      }).sort((a, b) => b.cpu - a.cpu);
      for (const r of rows) {
        const p = r.p;
        const virt = 4096 + p.pid * 128;
        c.out(`${pad(p.pid, 7, true)} ${pad(userName(kernel, p.uid), 8)} ${pad(20 + p.nice, 3, true)} ${pad(p.nice, 3, true)} ${pad(Math.round(virt), 7, true)} ${pad(Math.round(r.rss), 6, true)} ${pad(Math.round(r.rss * 0.4), 6, true)} ${stateOf(p)} ${pad(r.cpu.toFixed(1), 5, true)} ${pad(r.mem.toFixed(1), 5, true)} ${pad(procTime(p.cpu), 8, true)} ${p.name}\n`);
      }
      if (it < iterations - 1) {
        c.out('\n');
        if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay * 1000, 2000)));
      }
    }
    return 0;
  });

  /* ------------------------------ free ------------------------------ */
  reg(ctx, 'free', 'display amount of free and used memory', async (c) => {
    const o = parseOpts(c.args, 'hmgstwb', { human: 'h', mega: 'm', giga: 'g', si: 'g', total: 't', wide: 'w', seconds: 's:' });
    const m = kernel.memoryInfo();
    const unit = o.h ? 'human' : o.g ? 'g' : o.m ? 'm' : 'k';
    const conv = (n) => {
      if (unit === 'human') return humanSize(n);
      if (unit === 'g') return (n / 1073741824).toFixed(1) + 'Gi';
      if (unit === 'm') return (n / 1048576).toFixed(0) + 'Mi';
      return String(Math.round(n / 1024));
    };
    const header = o.w
      ? ['total', 'used', 'free', 'shared', 'buffers', 'cache', 'available']
      : ['total', 'used', 'free', 'shared', 'buff/cache', 'available'];
    const rows = [['Mem:', conv(m.total), conv(m.used), conv(m.free), '0', '0', conv(m.free)]];
    rows.push(['Swap:', '0', '0', '0', '', '', '']);
    c.out(table(rows, ['', ...header], [1, 2, 3, 4, 5, 6]));
    if (o.t) {
      const r = ['Total:', conv(m.total), conv(m.used), conv(m.free), '0', '0', conv(m.free)];
      c.out(r.join(' ') + '\n');
    }
    return 0;
  });

  /* ------------------------------ uptime / vmstat etc ------------------------------ */
  reg(ctx, 'uptime', 'tell how long the system has been running', async (c) => {
    const o = parseOpts(c.args, 'ps', { pretty: 'p', since: 's' });
    if (o.p) { c.out(fmtUptimePretty(kernel.uptime) + '\n'); return 0; }
    if (o.s) { c.out(new Date(kernel.bootTime).toISOString().slice(0, 19).replace('T', ' ') + '\n'); return 0; }
    c.out(` ${new Date().toISOString().slice(11, 19)} up ${fmtDuration(kernel.uptime)},  1 user,  load average: 0.00, 0.00, 0.00\n`);
    return 0;
  });

  reg(ctx, 'vmstat', 'report virtual memory statistics', async (c) => {
    const o = parseOpts(c.args, 'n:');
    const m = kernel.memoryInfo();
    const procs = [...kernel.procs.values()];
    c.out('procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n');
    c.out(' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st\n');
    c.out(` ${procs.filter((p) => p.state === 'R').length}  0      0 ${pad(Math.round(m.free / 1024), 6, true)}      0      0    0    0     0     0   ${Math.max(1, procs.length * 3)}   ${Math.max(1, procs.length * 7)}  1  0 ${99 - (topSeq % 3)}  0  0\n`);
    if (o.n) c.out(`${' '.repeat(1)}${' snapshot'}\n`);
    return 0;
  });

  reg(ctx, 'iostat', 'report CPU and I/O statistics', async (c) => {
    const m = kernel.memoryInfo();
    c.out(`Linux ${REL} (${kernel.hostname}) \t${new Date().toISOString().slice(0, 10)} \t_${MACHINE}_\n`);
    c.out('avg-cpu:  %user   %nice %system %iowait  %steal   %idle\n');
    c.out('           0.52    0.00    0.31    0.04    0.00   99.13\n\n');
    c.out('Device            tps    kB_read/s    kB_wrtn/s    kB_dscd/s    kB_read    kB_wrtn    kB_dscd\n');
    c.out(`loop0            0.02         0.10         0.00         0.00        512          0          0\n`);
    c.out(`root             0.41         8.20         4.10         0.00      ${Math.round(m.used / 1024)}     ${Math.round(m.free / 2048)}          0\n`);
    return 0;
  });

  reg(ctx, 'mpstat', 'report processors related statistics', async (c) => {
    c.out(`Linux ${REL} (${kernel.hostname}) \t${new Date().toISOString().slice(0, 10)} \t_${MACHINE}_\t(${NCPU} CPU)\n`);
    c.out(`${new Date().toISOString().slice(11, 19)}  CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal  %guest  %gnice   %idle\n`);
    for (let i = 0; i < NCPU; i++) {
      c.out(`${new Date().toISOString().slice(11, 19)}  ${pad(i, 3, true)}    0.52    0.00    0.31    0.04    0.00    0.02    0.00    0.00    0.00   99.11\n`);
    }
    c.out(`${new Date().toISOString().slice(11, 19)}  all    0.52    0.00    0.31    0.04    0.00    0.02    0.00    0.00    0.00   99.11\n`);
    return 0;
  });

  reg(ctx, 'pidstat', 'report statistics for Linux tasks', async (c) => {
    const o = parseOpts(c.args, 'p:u:');
    c.out(`Linux ${REL} (${kernel.hostname}) \t${new Date().toISOString().slice(0, 10)} \t_${MACHINE}_\t(${NCPU} CPU)\n`);
    c.out(`\n${new Date().toISOString().slice(11, 19)}   UID       PID    %usr %system  %guest   %wait    %CPU   CPU  Command\n`);
    let list = [...kernel.procs.values()];
    const pids = parsePidList(o.p);
    if (pids) list = list.filter((p) => pids.includes(p.pid));
    for (const p of list) {
      const cpu = (((p.pid * 7) % 30) / 10);
      c.out(`${new Date().toISOString().slice(11, 19)} ${pad(p.uid, 6, true)} ${pad(p.pid, 9, true)} ${pad(cpu.toFixed(2), 7, true)}    0.00    0.00    0.00 ${pad(cpu.toFixed(2), 7, true)} ${pad(0, 4, true)}  ${p.name}\n`);
    }
    return 0;
  });

  reg(ctx, 'sar', 'collect, report system activity (basic snapshot)', async (c) => {
    const o = parseOpts(c.args, 'n:u');
    c.out(`Linux ${REL} (${kernel.hostname}) \t${new Date().toISOString().slice(0, 10)} \t_${MACHINE}_\t(${NCPU} CPU)\n`);
    c.out(`\n${new Date().toISOString().slice(11, 19)}  LINUX RESTART\t(1 CPU)\n`);
    c.out(`\n${new Date().toISOString().slice(11, 19)}\tCPU\t%user\t%nice\t%system\t%iowait\t%steal\t%idle\n`);
    c.out(`${new Date().toISOString().slice(11, 19)}\tall\t0.52\t0.00\t0.31\t0.04\t0.00\t99.13\n`);
    c.out(`\nAverage:\tall\t0.52\t0.00\t0.31\t0.04\t0.00\t99.13\n`);
    if (!o.n && !o.u) c.out('sar: warning: activity data is synthesized for this session\n');
    return 0;
  });

  /* ------------------------------ uname & machine info ------------------------------ */
  reg(ctx, 'uname', 'print system information', async (c) => {
    const o = parseOpts(c.args, 'asrvnmo', {
      all: 'a', kernel: 's', release: 'r', version: 'v', nodename: 'n', machine: 'm', operating: 'o',
    });
    const all = !!o.a;
    const bits = [];
    if (all || o.s) bits.push('Linux');
    if (all || o.n) bits.push(kernel.hostname);
    if (all || o.r) bits.push(REL);
    if (all || o.v) bits.push('#1 SMP PREEMPT_DYNAMIC WebOS 6.6.0-1');
    if (all || o.m) bits.push(MACHINE);
    if (all || o.o) bits.push('GNU/Linux');
    if (!bits.length) bits.push('Linux');
    c.out(bits.join(' ') + '\n');
    return 0;
  });

  reg(ctx, 'arch', 'print the machine hardware name', async (c) => {
    c.out(MACHINE + '\n');
    return 0;
  });

  reg(ctx, 'nproc', 'print the number of processing units available', async (c) => {
    const o = parseOpts(c.args, '', { all: 'all' });
    c.out(String(o.all ? NCPU : NCPU) + '\n');
    return 0;
  });

  reg(ctx, 'lscpu', 'display information about the CPU architecture', async (c) => {
    const lines = [
      `Architecture:                         ${MACHINE}`,
      'CPU op-mode(s):                       32-bit, 64-bit',
      'Address sizes:                        39 bits physical, 48 bits virtual',
      'Byte Order:                           Little Endian',
      `CPU(s):                               ${NCPU}`,
      `On-line CPU(s) list:                  ${Array.from({ length: NCPU }, (_, i) => i).join('-')}`,
      'Vendor ID:                            WebOS',
      'Model name:                           WebOS Virtual CPU @ 2.40GHz',
      'Thread(s) per core:                   1',
      'Core(s) per socket:                   ' + NCPU,
      'Socket(s):                            1',
      'NUMA node(s):                         1',
      'Hypervisor vendor:                    JavaScript',
      `Virtualization type:                  full`,
      'L1d cache:                            32 KiB',
      'L1i cache:                            32 KiB',
      'L2 cache:                             256 KiB',
      'L3 cache:                             8 MiB',
      'Flags:                                fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss ht syscall nx lm constant_tsc rep_good nopl cpuid pni pclmulqdq ssse3 fma cx16 sse4_1 sse4_2 movbe popcnt aes xsave avx f16c rdrand hypervisor lahf_lm abm 3dnowprefetch',
    ];
    c.out(lines.join('\n') + '\n');
    return 0;
  });

  reg(ctx, 'lsblk', 'list block devices', async (c) => {
    const o = parseOpts(c.args, 'fpnl', { fs: 'f', paths: 'p', 'noheadings': 'n', list: 'l' });
    const rows = [
      ['loop0', '7:0', '0', '8G', '0', 'loop', '/'],
      ['rootfs', '0:1', '0', '8G', '0', 'disk', '/'],
    ];
    if (!o.n) c.out(o.l ? 'NAME MAJ:MIN RM SIZE RO TYPE MOUNTPOINTS\n' : 'NAME   MAJ:MIN RM SIZE RO TYPE MOUNTPOINTS\n');
    for (const r of rows) {
      if (o.l) c.out(r.join(' ') + '\n');
      else c.out(`${pad(r[0], 6)} ${pad(r[1], 7, true)} ${pad(r[2], 2, true)} ${pad(r[3], 3, true)} ${pad(r[4], 2, true)} ${pad(r[5], 4)} ${r[6]}\n`);
    }
    return 0;
  });

  reg(ctx, 'lsusb', 'list USB devices', async (c) => {
    c.out('Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub\n');
    c.out('Bus 001 Device 002: ID 0627:0001 Adomax Technology Co., Ltd WebOS Virtual Keyboard\n');
    c.out('Bus 001 Device 003: ID 0627:0001 Adomax Technology Co., Ltd WebOS Virtual Mouse\n');
    return 0;
  });

  reg(ctx, 'lspci', 'list all PCI devices', async (c) => {
    c.out('00:00.0 Host bridge: WebOS Virtualization Host Bridge\n');
    c.out('00:01.0 VGA compatible controller: Device 1234:1111 (rev 02)\n');
    c.out('00:02.0 Ethernet controller: Red Hat, Inc. Virtio network device\n');
    c.out('00:03.0 USB controller: Intel Corporation 82371SB PIIX3 USB [Natoma/Triton II]\n');
    return 0;
  });

  reg(ctx, 'dmidecode', 'DMI table decoder', async (c) => {
    if (!isRoot(c)) return reportErr(c, 'dmidecode: /dev/mem: Permission denied (try as root)');
    c.out(`# dmidecode 3.4\nGetting SMBIOS data from sysfs.\nSMBIOS 3.0.0 present.\n\n`);
    c.out('Handle 0x0000, DMI type 0, 26 bytes\nBIOS Information\n\tVendor: WebOS\n\tVersion: 1.0.0\n\tRelease Date: 01/01/2026\n\tAddress: 0xE0000\n\tRuntime Size: 128 kB\n\tROM Size: 16 MB\n\tCharacteristics:\n\t\tPCI is supported\n\t\tBIOS is upgradeable\n\n');
    c.out('Handle 0x0001, DMI type 1, 27 bytes\nSystem Information\n\tManufacturer: WebOS Project\n\tProduct Name: WebOS Virtual Machine\n\tVersion: 1.0\n\tSerial Number: 0000-0000-0000\n\tUUID: 00000000-0000-0000-0000-000000000000\n\n');
    c.out('Handle 0x0004, DMI type 4, 48 bytes\nProcessor Information\n\tSocket Designation: CPU 0\n\tType: Central Processor\n\tFamily: Virtual CPU\n\tManufacturer: WebOS\n\tVersion: WebOS Virtual CPU @ 2.40GHz\n\tMax Speed: 2400 MHz\n\tCurrent Speed: 2400 MHz\n\tCore Count: ' + NCPU + '\n\tThread Count: ' + NCPU + '\n');
    return 0;
  });

  reg(ctx, 'hwinfo', 'probe for hardware (summary)', async (c) => {
    const m = kernel.memoryInfo();
    c.out('============ start debug info ============\n');
    c.out(`Architecture: ${MACHINE}\n`);
    c.out('Hardware Class: system\nModel: "WebOS Virtual Machine"\n');
    c.out(`Processor: 0\n  Model: "WebOS Virtual CPU"\n  Cores: ${NCPU}\n`);
    c.out(`Memory: ${humanSize(m.total)} total\n`);
    c.out('Storage: /dev/loop0 8 GiB\n');
    c.out('Network: virtio-net (virtual)\n');
    c.out('============ end debug info ============\n');
    return 0;
  });

  /* ------------------------------ hostname & identity ------------------------------ */
  reg(ctx, 'hostname', 'show or set the system hostname', async (c) => {
    const o = parseOpts(c.args, 'sifId', { short: 's', fqdn: 'f', ip: 'i', allips: 'I', domain: 'd' });
    if (o._.length) {
      if (!isRoot(c)) return reportErr(c, 'hostname: you must be root to change the host name');
      const name = String(o._[0]).trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(name)) return reportErr(c, `hostname: invalid host name '${name}'`);
      kernel.hostname = name;
      try { writeEtc(c, '/etc/hostname', name + '\n'); } catch { /* ignore */ }
      return 0;
    }
    const hn = kernel.hostname;
    if (o.s) c.out(hn.split('.')[0] + '\n');
    else if (o.f || o.d) c.out(hn.split('.')[0] + (kernel.domainname ? '.' + kernel.domainname : '') + '\n');
    else if (o.i) c.out('127.0.1.1\n');
    else if (o.I) c.out('127.0.0.1 127.0.1.1\n');
    else c.out(hn + '\n');
    return 0;
  });

  for (const [cmd, key] of [['domainname', 'domainname'], ['dnsdomainname', 'domainname']]) {
    reg(ctx, cmd, 'show or set the NIS/domain name', async (c) => {
      if (c.args.length && !c.args[0].startsWith('-')) {
        if (!isRoot(c)) return reportErr(c, `${cmd}: you must be root to change the domain name`);
        kernel.domainname = c.args[0];
        return 0;
      }
      if (kernel.domainname) c.out(kernel.domainname + '\n');
      return 0;
    });
  }

  reg(ctx, 'whoami', 'print effective user name', async (c) => {
    c.out(userName(kernel, c.uid) + '\n');
    return 0;
  });

  reg(ctx, 'id', 'print user and group information', async (c) => {
    const o = parseOpts(c.args, 'ugGnr', { user: 'u', group: 'g', groups: 'G', name: 'n', real: 'r' });
    let user = kernel.userByUid(c.uid);
    if (o._[0]) {
      user = kernel.userByName(o._[0]) || kernel.userByUid(Number(o._[0]));
      if (!user) return reportErr(c, `id: '${o._[0]}': no such user`);
    }
    if (!user) return reportErr(c, 'id: cannot find name for user ID ' + c.uid);
    const gids = o.r ? [user.gid] : groupsOf(kernel, user);
    const label = (gid) => o.n ? groupName(kernel, gid) : String(gid);
    if (o.u) { c.out((o.n ? user.name : String(user.uid)) + '\n'); return 0; }
    if (o.g) { c.out((o.n ? groupName(kernel, user.gid) : String(user.gid)) + '\n'); return 0; }
    if (o.G) { c.out(gids.map(label).join(' ') + '\n'); return 0; }
    const primary = o.n ? groupName(kernel, user.gid) : String(user.gid);
    c.out(`uid=${user.uid}(${user.name}) gid=${primary}(${groupName(kernel, user.gid)}) groups=${gids.map((g) => `${g}(${groupName(kernel, g)})`).join(',')}\n`);
    return 0;
  });

  reg(ctx, 'groups', 'print the groups a user is in', async (c) => {
    let user = kernel.userByUid(c.uid);
    if (c.args.length) {
      user = kernel.userByName(c.args[0]);
      if (!user) return reportErr(c, `groups: '${c.args[0]}': no such user`);
    }
    c.out(groupsOf(kernel, user).map((g) => groupName(kernel, g)).join(' ') + '\n');
    return 0;
  });

  reg(ctx, 'users', 'print the user names of users currently logged in', async (c) => {
    const names = [...new Set([...kernel.procs.values()].filter((p) => p.tty).map((p) => userName(kernel, p.uid)))];
    if (!names.length) names.push(userName(kernel, c.uid));
    c.out(names.join(' ') + '\n');
    return 0;
  });

  reg(ctx, 'who', 'show who is logged on', async (c) => {
    const o = parseOpts(c.args, 'abq', { all: 'a', boot: 'b', count: 'q' });
    const procs = [...kernel.procs.values()].filter((p) => p.tty && p.name !== 'init');
    const names = [...new Set(procs.map((p) => userName(kernel, p.uid)))];
    if (o.q) { c.out(names.join(' ') + '\n'); return 0; }
    if (o.b) c.out(`         system boot  ${fmtDate(kernel.bootTime)}\n`);
    const first = new Map();
    for (const p of procs) if (!first.has(p.uid)) first.set(p.uid, p);
    for (const p of first.values()) {
      c.out(`${pad(userName(kernel, p.uid), 8)} ${pad(p.tty.replace('/dev/', ''), 12)} ${fmtDate(p.started).slice(0, 16)}\n`);
    }
    return 0;
  });

  reg(ctx, 'w', 'show who is logged on and what they are doing', async (c) => {
    const m = kernel.memoryInfo();
    void m;
    c.out(` ${new Date().toISOString().slice(11, 19)} up ${fmtDuration(kernel.uptime)},  1 user,  load average: 0.00, 0.00, 0.00\n`);
    c.out('USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT\n');
    const seen = new Set();
    for (const p of [...kernel.procs.values()]) {
      if (!p.tty || seen.has(p.uid)) continue;
      seen.add(p.uid);
      c.out(`${pad(userName(kernel, p.uid), 8)} ${pad(p.tty.replace('/dev/', ''), 8)} ${pad('-', 16)} ${pad(fmtTime(p.started).slice(0, 5), 7)} ${pad('0.00s', 6)} ${pad('0.01s', 6)} ${pad('0.00s', 6)} -bash\n`);
    }
    return 0;
  });

  reg(ctx, 'last', 'show listing of last logged in users', async (c) => {
    const o = parseOpts(c.args, 'n:w:x', { number: 'n:' });
    try {
      const wtmp = readTextFile(c, '/var/log/wtmp');
      if (wtmp.trim()) { c.out(wtmp); return 0; }
    } catch { /* absent */ }
    c.out(`\nwtmp begins ${fmtDate(kernel.bootTime, { long: true })}\n`);
    return 0;
  });

  reg(ctx, 'lastb', 'show listing of bad login attempts', async (c) => {
    try {
      const btmp = readTextFile(c, '/var/log/btmp');
      if (btmp.trim()) { c.out(btmp); return 0; }
    } catch { /* absent */ }
    c.out(`\nbtmp begins ${fmtDate(kernel.bootTime, { long: true })}\n`);
    return 0;
  });

  reg(ctx, 'logname', 'print user\'s login name', async (c) => {
    const name = c.env.LOGNAME || kernel.userByUid(c.uid)?.name;
    if (!name) return reportErr(c, 'logname: no login name');
    c.out(name + '\n');
    return 0;
  });

  reg(ctx, 'tty', 'print the file name of the terminal connected to stdin', async (c) => {
    c.out('not a tty\n');
    return 1;
  });

  reg(ctx, 'getent', 'get entries from administrative databases', async (c) => {
    const db = c.args[0];
    const key = c.args[1];
    if (!db) return reportErr(c, 'getent: missing database argument', 2);
    const match = (line, fields, indexes) => {
      if (key == null) return true;
      return indexes.some((i) => fields[i] === key);
    };
    if (db === 'passwd') {
      for (const line of etcText(c, '/etc/passwd').split('\n').filter(Boolean)) {
        const f = line.split(':');
        if (match(line, f, [0, 2])) c.out(line + '\n');
      }
      return 0;
    }
    if (db === 'group') {
      for (const line of etcText(c, '/etc/group').split('\n').filter(Boolean)) {
        const f = line.split(':');
        if (match(line, f, [0, 2])) c.out(line + '\n');
      }
      return 0;
    }
    if (db === 'hosts') {
      const hosts = etcText(c, '/etc/hosts', '127.0.0.1\tlocalhost\n127.0.1.1\t' + kernel.hostname + '\n');
      let any = false;
      for (const line of hosts.split('\n')) {
        const f = line.trim().split(/\s+/);
        if (!f[0] || f[0].startsWith('#')) continue;
        if (key == null || f[0] === key || f.slice(1).includes(key)) { c.out(line + '\n'); any = true; }
      }
      if (!any && key != null) return 1;
      return 0;
    }
    if (db === 'services') {
      const services = [
        ['ssh', '22/tcp'], ['domain', '53/tcp'], ['domain', '53/udp'], ['http', '80/tcp'],
        ['https', '443/tcp'], ['ntp', '123/udp'], ['imap', '143/tcp'], ['smtp', '25/tcp'],
      ].map(([n, p]) => `${n}\t\t${p}`).join('\n') + '\n';
      let any = false;
      for (const line of services.split('\n')) {
        if (!line) continue;
        if (key == null || line.startsWith(key + '\t') || line.includes(key + '/')) { c.out(line + '\n'); any = true; }
      }
      return any || key == null ? 0 : 1;
    }
    if (db === 'protocols') {
      const protocols = 'ip\t0\tIP\nicmp\t1\tICMP\ntcp\t6\tTCP\nudp\t17\tUDP\nipv6\t41\tIPv6\n';
      for (const line of protocols.split('\n')) {
        if (!line) continue;
        if (key == null || line.split('\t')[0] === key) c.out(`${line}\n`);
      }
      return 0;
    }
    return reportErr(c, `getent: unknown database '${db}'`, 2);
  });

  /* ------------------------------ user & group management ------------------------------ */
  function requireRoot(c, cmd) {
    if (isRoot(c)) return null;
    return reportErr(c, `${cmd}: Permission denied (you must be root)`);
  }

  function removeTree(c, p) {
    let st;
    try { st = c.vfs.stat(p, c.cred(), { followFinal: false }); } catch { return; }
    if (st.isDirectory()) {
      let names = [];
      try { names = c.vfs.readdir(p, c.cred()); } catch { return; }
      for (const n of names) removeTree(c, p === '/' ? '/' + n : p + '/' + n);
      try { c.vfs.rmdir(p, c.cred()); } catch { /* ignore */ }
    } else {
      try { c.vfs.unlink(p, c.cred()); } catch { /* ignore */ }
    }
  }

  function shadowMap(c) {
    const map = new Map();
    for (const line of etcText(c, '/etc/shadow').split('\n').filter(Boolean)) {
      const f = line.split(':');
      map.set(f[0], f);
    }
    return map;
  }

  function writeShadowMap(c, map) {
    const lines = [...map.entries()].map(([, f]) => f.join(':'));
    writeEtc(c, '/etc/shadow', lines.join('\n') + '\n', 0o640);
  }

  function nextUid(kernel, system) {
    const floor = system ? 1 : 1000;
    let n = floor;
    while (kernel.users.some((u) => u.uid === n)) n++;
    return n;
  }

  function nextGid(kernel, system) {
    let n = system ? 1 : 1000;
    while (kernel.groups.some((g) => g.gid === n)) n++;
    return n;
  }

  reg(ctx, 'useradd', 'create a new user account', async (c) => {
    const r = requireRoot(c, 'useradd'); if (r != null) return r;
    const o = parseOpts(c.args, 'mru:g:G:c:d:s:p:e:k:U', {
      createhome: 'm', system: 'r', uid: 'u:', gid: 'g:', groups: 'G:', comment: 'c:',
      home: 'd:', shell: 's:', password: 'p:', expiry: 'e:',
    });
    const name = o._[0];
    if (!name) return reportErr(c, 'useradd: missing user name', 2);
    if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(name)) return reportErr(c, `useradd: invalid user name '${name}'`, 2);
    if (kernel.userByName(name)) return reportErr(c, `useradd: user '${name}' already exists`, 9);
    const uid = o.u != null ? Number(o.u) : nextUid(kernel, !!o.r);
    if (kernel.userByUid(uid)) return reportErr(c, `useradd: UID ${uid} is not unique`, 4);
    let gid;
    if (o.g != null) {
      const g = kernel.groupByName(o.g) || kernel.groupByGid(Number(o.g));
      if (!g) return reportErr(c, `useradd: group '${o.g}' does not exist`, 6);
      gid = g.gid;
    } else {
      let g = kernel.groupByName(name);
      if (!g) { g = { name, gid: nextGid(kernel, !!o.r), members: [] }; kernel.groups.push(g); }
      gid = g.gid;
    }
    const home = o.d || (o.r ? '/nonexistent' : `/home/${name}`);
    const shell = o.s || '/bin/bash';
    kernel.users.push({ name, uid, gid, gecos: o.c || name, home, shell });
    if (o.G) {
      for (const gn of String(o.G).split(',')) {
        const g = kernel.groupByName(gn);
        if (g && !g.members.includes(name)) g.members.push(name);
      }
    }
    if (o.m) {
      try {
        c.vfs.mkdirp(home, c.cred(), 0o755);
        c.vfs.chown(home, uid, gid, c.cred());
      } catch (e) { c.err(`useradd: cannot create directory ${home}: ${errnoText(e)}\n`); }
    }
    syncPasswd(kernel, c); syncGroup(kernel, c); syncShadow(kernel, c);
    return 0;
  });

  reg(ctx, 'userdel', 'delete a user account', async (c) => {
    const r = requireRoot(c, 'userdel'); if (r != null) return r;
    const o = parseOpts(c.args, 'rf', { remove: 'r', force: 'f' });
    const name = o._[0];
    if (!name) return reportErr(c, 'userdel: missing user name', 2);
    const user = kernel.userByName(name);
    if (!user) return o.f ? 0 : reportErr(c, `userdel: user '${name}' does not exist`, 6);
    kernel.users = kernel.users.filter((u) => u.name !== name);
    for (const g of kernel.groups) g.members = (g.members || []).filter((m) => m !== name);
    if (o.r) removeTree(c, user.home);
    syncPasswd(kernel, c); syncGroup(kernel, c); syncShadow(kernel, c);
    return 0;
  });

  reg(ctx, 'usermod', 'modify a user account', async (c) => {
    const r = requireRoot(c, 'usermod'); if (r != null) return r;
    const o = parseOpts(c.args, 'amc:d:e:g:G:l:p:s:u:LU', {
      append: 'a', comment: 'c:', home: 'd:', expiry: 'e:', gid: 'g:', groups: 'G:',
      login: 'l:', password: 'p:', shell: 's:', uid: 'u:', lock: 'L', unlock: 'U',
    });
    const name = o._[0];
    if (!name) return reportErr(c, 'usermod: missing user name', 2);
    const user = kernel.userByName(name);
    if (!user) return reportErr(c, `usermod: user '${name}' does not exist`, 6);
    if (o.u != null) {
      const uid = Number(o.u);
      if (kernel.userByUid(uid) && uid !== user.uid) return reportErr(c, `usermod: UID ${uid} is not unique`, 4);
      user.uid = uid;
    }
    if (o.g != null) {
      const g = kernel.groupByName(o.g) || kernel.groupByGid(Number(o.g));
      if (!g) return reportErr(c, `usermod: group '${o.g}' does not exist`, 6);
      user.gid = g.gid;
    }
    if (o.d) {
      const oldHome = user.home;
      user.home = o.d;
      if (o.m) { try { c.vfs.rename(oldHome, o.d, c.cred()); } catch { /* ignore */ } }
    }
    if (o.s) user.shell = o.s;
    if (o.c != null) user.gecos = o.c;
    if (o.l) {
      const old = user.name;
      if (kernel.userByName(o.l)) return reportErr(c, `usermod: user '${o.l}' already exists`, 6);
      user.name = o.l;
      for (const g of kernel.groups) g.members = (g.members || []).map((m) => (m === old ? o.l : m));
    }
    if (o.G) {
      const list = String(o.G).split(',').filter(Boolean);
      if (!o.a) for (const g of kernel.groups) g.members = (g.members || []).filter((m) => m !== user.name);
      for (const gn of list) {
        const g = kernel.groupByName(gn);
        if (g && !g.members.includes(user.name)) g.members.push(user.name);
      }
    }
    if (o.L || o.U || o.p != null) {
      const map = shadowMap(c);
      const f = map.get(user.name) || [user.name, '!*', '19000', '0', '99999', '7', '', '', ''];
      if (o.p != null) f[1] = o.p;
      if (o.L && !f[1].startsWith('!')) f[1] = '!' + f[1];
      if (o.U) f[1] = f[1].replace(/^!/, '');
      map.set(user.name, f);
      writeShadowMap(c, map);
    }
    syncPasswd(kernel, c); syncGroup(kernel, c);
    return 0;
  });

  reg(ctx, 'groupadd', 'create a new group', async (c) => {
    const r = requireRoot(c, 'groupadd'); if (r != null) return r;
    const o = parseOpts(c.args, 'g:rf', { gid: 'g:', force: 'f' });
    const name = o._[0];
    if (!name) return reportErr(c, 'groupadd: missing group name', 2);
    if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(name)) return reportErr(c, `groupadd: invalid group name '${name}'`, 2);
    if (kernel.groupByName(name)) {
      if (o.f) return 0;
      return reportErr(c, `groupadd: group '${name}' already exists`, 9);
    }
    const gid = o.g != null ? Number(o.g) : nextGid(kernel, false);
    if (kernel.groupByGid(gid)) return reportErr(c, `groupadd: GID ${gid} is not unique`, 4);
    kernel.groups.push({ name, gid, members: [] });
    syncGroup(kernel, c);
    return 0;
  });

  reg(ctx, 'groupdel', 'delete a group', async (c) => {
    const r = requireRoot(c, 'groupdel'); if (r != null) return r;
    const name = c.args[0];
    if (!name) return reportErr(c, 'groupdel: missing group name', 2);
    const g = kernel.groupByName(name);
    if (!g) return reportErr(c, `groupdel: group '${name}' does not exist`, 6);
    kernel.groups = kernel.groups.filter((x) => x.name !== name);
    for (const u of kernel.users) if (u.gid === g.gid) u.gid = 100;
    syncGroup(kernel, c); syncPasswd(kernel, c);
    return 0;
  });

  reg(ctx, 'groupmod', 'modify a group', async (c) => {
    const r = requireRoot(c, 'groupmod'); if (r != null) return r;
    const o = parseOpts(c.args, 'g:n:o:', { gid: 'g:', newname: 'n:', nonunique: 'o' });
    const name = o._[0];
    if (!name) return reportErr(c, 'groupmod: missing group name', 2);
    const g = kernel.groupByName(name);
    if (!g) return reportErr(c, `groupmod: group '${name}' does not exist`, 6);
    if (o.g != null) {
      const gid = Number(o.g);
      if (kernel.groupByGid(gid) && gid !== g.gid && !o.o) return reportErr(c, `groupmod: GID ${gid} is not unique`, 4);
      const oldGid = g.gid;
      g.gid = gid;
      for (const u of kernel.users) if (u.gid === oldGid) u.gid = gid;
    }
    if (o.n) {
      if (kernel.groupByName(o.n)) return reportErr(c, `groupmod: group '${o.n}' already exists`, 6);
      g.name = o.n;
    }
    syncGroup(kernel, c); syncPasswd(kernel, c);
    return 0;
  });

  reg(ctx, 'passwd', 'change user password', async (c) => {
    const o = parseOpts(c.args, 'dlueS', { delete: 'd', lock: 'l', unlock: 'u', expire: 'e', status: 'S' });
    const name = o._[0] || userName(kernel, c.uid);
    const user = kernel.userByName(name);
    if (!user) return reportErr(c, `passwd: user '${name}' does not exist`, 1);
    if (!isRoot(c) && user.uid !== c.uid) return reportErr(c, `passwd: You may not view or modify password information for ${name}.`);
    const map = shadowMap(c);
    const f = map.get(name) || [name, '!*', '19000', '0', '99999', '7', '', '', ''];
    if (o.S) {
      const pw = f[1];
      const st = pw === '' ? 'NP' : pw.startsWith('!') || pw === '*' ? 'L' : 'P';
      const now = new Date();
      const mdY = `${z2(now.getUTCMonth() + 1)}/${z2(now.getUTCDate())}/${now.getUTCFullYear()}`;
      c.out(`${name} ${st} ${mdY} 0 99999 7 -1\n`);
      return 0;
    }
    if (o.d) {
      if (!isRoot(c)) return reportErr(c, 'passwd: You may not view or modify password information for this user.');
      f[1] = '';
      map.set(name, f); writeShadowMap(c, map);
      return 0;
    }
    if (o.l || o.u) {
      if (o.l && !f[1].startsWith('!')) f[1] = '!' + f[1];
      if (o.u) f[1] = f[1].replace(/^!/, '');
      map.set(name, f); writeShadowMap(c, map);
      return 0;
    }
    return reportErr(c, 'passwd: Sorry, passwords cannot be read in a non-interactive session (no TTY)');
  });

  reg(ctx, 'chsh', 'change your login shell', async (c) => {
    const o = parseOpts(c.args, 's:l', { shell: 's:', list: 'l' });
    if (o.l) {
      c.out(etcText(c, '/etc/shells', '/bin/sh\n/bin/bash\n/bin/dash\n/usr/bin/zsh\n'));
      return 0;
    }
    const name = o._[0] || userName(kernel, c.uid);
    const user = kernel.userByName(name);
    if (!user) return reportErr(c, `chsh: user '${name}' does not exist`);
    if (!isRoot(c) && user.uid !== c.uid) return reportErr(c, `chsh: Permission denied`);
    if (!o.s) return reportErr(c, 'chsh: interactive shell selection is not supported without a TTY; use -s SHELL');
    user.shell = o.s;
    syncPasswd(kernel, c);
    return 0;
  });

  reg(ctx, 'chfn', 'change your finger information', async (c) => {
    const o = parseOpts(c.args, 'f:r:w:h:o:', {
      fullname: 'f:', room: 'r:', workphone: 'w:', homephone: 'h:', office: 'o:',
    });
    const name = o._[0] || userName(kernel, c.uid);
    const user = kernel.userByName(name);
    if (!user) return reportErr(c, `chfn: user '${name}' does not exist`);
    if (!isRoot(c) && user.uid !== c.uid) return reportErr(c, 'chfn: Permission denied');
    const parts = (user.gecos || '').split(',');
    if (o.f != null) parts[0] = o.f;
    if (o.r != null) parts[1] = o.r;
    if (o.w != null) parts[2] = o.w;
    if (o.h != null) parts[3] = o.h;
    if (o.o != null) parts[4] = o.o;
    user.gecos = parts.join(',');
    syncPasswd(kernel, c);
    return 0;
  });

  reg(ctx, 'su', 'run a command with substitute user and group ID', async (c) => {
    let target = 'root', command = null;
    const rest = [];
    for (let i = 0; i < c.args.length; i++) {
      const a = c.args[i];
      if (a === '-c' || a === '--command') { command = c.args[++i] ?? ''; continue; }
      if (a === '-' || a === '-l' || a === '--login') { target = 'root'; continue; }
      if (a === '-s' || a === '--shell' || a === '-g' || a === '--group' || a === '-G') { i++; continue; }
      if (a.startsWith('-') && a.length > 1) continue;
      rest.push(a);
    }
    if (rest.length) {
      const first = rest[0];
      const named = kernel.userByName(first) || (/^\d+$/.test(first) ? kernel.userByUid(Number(first)) : null);
      if (!named) return reportErr(c, `su: user ${first} does not exist`);
      target = first;
      rest.shift();
      if (!command && rest.length) command = rest.join(' ');
    }
    const user = kernel.userByName(target) || kernel.userByUid(Number(target));
    if (!user) return reportErr(c, `su: user ${target} does not exist`);
    if (!command) {
      return reportErr(c, 'su: interactive shells are not supported without a TTY; use `su -c "command"` instead');
    }
    const session = spawnAs(c, user, command);
    const res = await session.done;
    return res.code;
  });

  reg(ctx, 'sudo', 'execute a command as another user', async (c) => {
    let target = 'root', command = [], login = false, list = false;
    for (let i = 0; i < c.args.length; i++) {
      const a = c.args[i];
      if (a === '-u' || a === '--user') { target = c.args[++i] || 'root'; continue; }
      if (a === '--') { command.push(...c.args.slice(i + 1)); break; }
      if (a === '-i' || a === '--login' || a === '-s' || a === '--shell') { login = true; continue; }
      if (a === '-l' || a === '--list') { list = true; continue; }
      if (a.startsWith('-') && a.length > 1) continue;
      command.push(...c.args.slice(i));
      break;
    }
    const user = kernel.userByName(target) || kernel.userByUid(Number(target));
    if (!user) return reportErr(c, `sudo: unknown user ${target}`);
    if (list) {
      c.out(`User ${userName(kernel, c.uid)} may run the following commands on ${kernel.hostname}:\n    (ALL : ALL) ALL\n`);
      return 0;
    }
    if (!command.length) {
      return reportErr(c, 'sudo: interactive shells are not supported without a TTY; use `sudo command` instead');
    }
    const session = spawnAs(c, user, command.join(' '));
    const res = await session.done;
    return res.code;
  });

  reg(ctx, 'newgrp', 'log in to a new group', async (c) => {
    const name = c.args[0];
    if (!name) return reportErr(c, 'newgrp: missing group name');
    const group = kernel.groupByName(name) || kernel.groupByGid(Number(name));
    if (!group) return reportErr(c, `newgrp: group '${name}' does not exist`);
    if (c.args.length > 1) {
      const user = { ...(kernel.userByUid(c.uid) || { name: userName(kernel, c.uid) }), gid: group.gid };
      const session = spawnAs(c, user, c.args.slice(1).join(' '));
      const res = await session.done;
      return res.code;
    }
    return reportErr(c, `newgrp: interactive shells are not supported without a TTY; group '${group.name}' requires a new login session`);
  });

  /* ------------------------------ time, jobs & signals ------------------------------ */
  async function pipeChannels(session, c) {
    const pump = async (ch, sink) => {
      try { for await (const chunk of ch) sink.write(chunk); } catch { /* ignore */ }
    };
    await Promise.all([pump(session.stdout, c.stdout), pump(session.stderr, c.stderr)]);
  }

  function parseSeconds(str) {
    const m = String(str).match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
    if (!m) return null;
    return Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2] || 's']);
  }

  async function sleepMs(ms, c) {
    const signal = c?.proc?.abort?.signal;
    if (signal?.aborted) return 130;
    return new Promise((resolve) => {
      let timer = null;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      const onAbort = () => { cleanup(); resolve(130); };
      timer = setTimeout(() => { cleanup(); resolve(0); }, Math.max(0, ms));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  reg(ctx, 'sleep', 'delay for a specified amount of time', async (c) => {
    if (!c.args.length) return reportErr(c, 'sleep: missing operand', 1);
    let total = 0;
    for (const a of c.args) {
      const v = parseSeconds(a);
      if (v == null) return reportErr(c, `sleep: invalid time interval '${a}'`, 1);
      total += v;
    }
    return sleepMs(total * 1000, c);
  });

  reg(ctx, 'usleep', 'sleep for a specified number of microseconds', async (c) => {
    const us = Number(c.args[0]);
    if (!c.args.length || Number.isNaN(us)) return reportErr(c, 'usleep: invalid number', 1);
    return sleepMs(us / 1000, c);
  });

  reg(ctx, 'timeout', 'run a command with a time limit', async (c) => {
    const o = parseOpts(c.args, 's:k:', { signal: 's:', 'kill-after': 'k:' });
    const dur = o._.shift();
    if (dur == null) return reportErr(c, 'timeout: missing duration', 125);
    const secs = parseSeconds(dur);
    if (secs == null) return reportErr(c, `timeout: invalid time interval '${dur}'`, 125);
    if (!o._.length) return reportErr(c, 'timeout: missing command', 125);
    const sig = (o.s || 'TERM').toUpperCase().replace(/^SIG/, '');
    const src = o._.map(quote).join(' ');
    const session = c.spawn(src);
    const piping = pipeChannels(session, c);
    const result = await Promise.race([
      session.done,
      new Promise((r) => setTimeout(() => r(null), secs * 1000)),
    ]);
    let code = 0;
    if (result === null) {
      try { kernel.kill(session.pid, sig); } catch { /* ignore */ }
      if (o.k != null) {
        const grace = parseSeconds(o.k) ?? 0;
        const done = await Promise.race([session.done, new Promise((r) => setTimeout(() => r('grace'), grace * 1000))]);
        if (done === 'grace') { try { kernel.kill(session.pid, 'KILL'); } catch { /* ignore */ } }
      }
      await piping;
      code = sig === 'KILL' ? 137 : 124;
    } else {
      await piping;
      code = result.code;
    }
    return code;
  });

  reg(ctx, 'nohup', 'run a command immune to hangups', async (c) => {
    if (!c.args.length) return reportErr(c, 'nohup: missing operand', 125);
    const appending = { PATH: c.env.PATH, HOME: c.home, USER: userName(kernel, c.uid) };
    void appending;
    const src = c.args.map(quote).join(' ');
    if (!c.args[0].includes('=')) {
      c.err("nohup: ignoring input and appending output to 'nohup.out'\n");
    }
    const session = c.spawn(src);
    const piping = pipeChannels(session, c);
    await session.done;
    await piping;
    return 0;
  });

  reg(ctx, 'nice', 'run a program with modified scheduling priority', async (c) => {
    const o = parseOpts(c.args, 'n:', { adjustment: 'n:' });
    const increment = o.n != null ? Number(o.n) : 10;
    if (!o._.length) { c.out(String(10) + '\n'); return 0; }
    const src = o._.map(quote).join(' ');
    const session = c.spawn(src);
    const piping = pipeChannels(session, c);
    const p = kernel.procs.get(session.pid);
    if (p) p.nice = Math.max(-20, Math.min(19, (p.nice || 0) + increment));
    const res = await session.done;
    await piping;
    return res.code;
  });

  reg(ctx, 'renice', 'alter priority of running processes', async (c) => {
    const o = parseOpts(c.args, 'n:p:', { priority: 'n:', pid: 'p:' });
    const args = c.args.filter((a) => !a.startsWith('-'));
    let value = o.n != null ? Number(o.n) : Number(args.shift());
    const pids = parsePidList(o.p) || args.map(Number).filter((n) => !Number.isNaN(n));
    if (Number.isNaN(value) || !pids.length) return reportErr(c, 'renice: invalid priority or PID', 1);
    if (!isRoot(c) && value < 0) return reportErr(c, 'renice: failed to set priority: Permission denied', 1);
    let exit = 0;
    for (const pid of pids) {
      const p = kernel.procs.get(pid);
      if (!p) { c.err(`renice: failed to get priority for ${pid}: No such process\n`); exit = 1; continue; }
      const old = p.nice ?? 0;
      p.nice = Math.max(-20, Math.min(19, value));
      c.out(`${pid} (process ID) old priority ${old}, new priority ${p.nice}\n`);
    }
    return exit;
  });

  reg(ctx, 'ionice', 'set or get process I/O scheduling class and priority (simulated)', async (c) => {
    const o = parseOpts(c.args, 'c:n:p:', { class: 'c:', 'classdata': 'n:', pid: 'p:' });
    if (o.p) {
      c.out(`none: prio ${4 + (Number(o.n) || 0)}\n`);
      return 0;
    }
    c.err('ionice: I/O scheduling is simulated only (no block layer in the browser sandbox)\n');
    if (o._.length) {
      const session = c.spawn(o._.map(quote).join(' '));
      const piping = pipeChannels(session, c);
      const res = await session.done;
      await piping;
      return res.code;
    }
    return 0;
  });

  reg(ctx, 'chrt', 'manipulate real-time attributes of a process (simulated)', async (c) => {
    const o = parseOpts(c.args, 'p', { pid: 'p' });
    if (o.p) {
      c.out('pid 1\'s current scheduling policy: SCHED_OTHER\npid 1\'s current scheduling priority: 0\n');
      return 0;
    }
    if (c.args.length && !c.args[0].startsWith('-')) {
      const rest = c.args.slice(1);
      if (rest.length) {
        const session = c.spawn(rest.map(quote).join(' '));
        const piping = pipeChannels(session, c);
        const res = await session.done;
        await piping;
        return res.code;
      }
      return 0;
    }
    return reportErr(c, 'chrt: real-time scheduling is not supported in the browser sandbox');
  });

  const SIGNAL_LIST = Object.entries(SIGNALS).map(([k, v]) => `${v}) SIG${k}`);
  for (const cmd of ['killall', 'pkill', 'pgrep', 'pidof']) {
    reg(ctx, cmd, 'look up or signal processes by name', async (c) => {
      if (c.args.includes('-l') && cmd === 'killall') {
        c.out(SIGNAL_LIST.join(' ') + '\n');
        return 0;
      }
      const { sig, rest } = signalArgs(c.args);
      const o = parseOpts(rest, 'efxnu:oaswqI', {
        exact: 'e', full: 'f', user: 'u:', newest: 'n', oldest: 'o', listfull: 'a', signal: 's:',
        wait: 'w', quiet: 'q', ignorecase: 'I',
      });
      if (o.s) sig = String(o.s).toUpperCase().replace(/^SIG/, '');
      if (cmd === 'pidof') {
        const names = o._;
        if (!names.length) return 0;
        const seen = new Set();
        for (const name of names) {
          for (const p of kernel.procs.values()) {
            const base = (p.argv?.[0] || p.name).split('/').pop();
            if (p.name === name || base === name) seen.add(p.pid);
          }
        }
        if (!seen.size) return 1;
        c.out([...seen].join(' ') + '\n');
        return 0;
      }
      const pattern = o._[0];
      if (pattern == null) return reportErr(c, `${cmd}: no process name specified`, 2);
      const matched = matchProcs(kernel, c, pattern, o);
      if (!matched.length) {
        if (!o.q && cmd !== 'pgrep') c.err(`${cmd}: no process found\n`);
        return 1;
      }
      if (cmd === 'pgrep') {
        for (const p of matched) c.out(o.a ? `${p.pid} ${procArgs(p)}\n` : `${p.pid}\n`);
        return 0;
      }
      const signal = sig || 'TERM';
      let killed = 0;
      for (const p of matched) {
        try { kernel.kill(p.pid, signal); killed++; if (o.w) c.err(`${signal === 'TERM' ? 'Killed' : signal} ${p.name}(${p.pid})\n`); }
        catch { /* ignore */ }
      }
      return killed ? 0 : 1;
    });
  }

  reg(ctx, 'env', 'run a program in a modified environment', async (c) => {
    const o = parseOpts(c.args, 'i0u:', { 'ignore-environment': 'i', null: '0', unset: 'u:' });
    const args = o._.slice();
    const assigns = [];
    while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) assigns.push(args.shift());
    if (!args.length) {
      const env = o.i ? {} : { ...c.env };
      for (const name of [].concat(o.u || [])) delete env[name];
      for (const a of assigns) { const i = a.indexOf('='); env[a.slice(0, i)] = a.slice(i + 1); }
      const text = Object.keys(env).sort().map((k) => `${k}=${env[k]}`).join(o['0'] ? '\0' : '\n');
      c.stdout.write(text + (text ? (o['0'] ? '\0' : '\n') : ''));
      return 0;
    }
    const src = assigns.map((a) => `export ${a.slice(0, a.indexOf('='))}=${quote(a.slice(a.indexOf('=') + 1))}`).join('; ')
      + (assigns.length ? '; ' : '') + args.map(quote).join(' ');
    const session = c.spawn(src);
    const piping = pipeChannels(session, c);
    const res = await session.done;
    await piping;
    return res.code;
  });

  reg(ctx, 'printenv', 'print all or part of environment', async (c) => {
    if (!c.args.length) {
      for (const k of Object.keys(c.env).sort()) c.out(`${k}=${c.env[k]}\n`);
      return 0;
    }
    let exit = 0;
    for (const name of c.args) {
      if (c.env[name] === undefined) exit = 1;
      else c.out(`${c.env[name]}\n`);
    }
    return exit;
  });

  reg(ctx, 'watch', 'execute a program periodically (batch: two iterations)', async (c) => {
    const o = parseOpts(c.args, 'n:td', { interval: 'n:', 'no-title': 't', differences: 'd' });
    const sec = o.n != null ? Number(o.n) : 2;
    if (Number.isNaN(sec) || sec <= 0) return reportErr(c, 'watch: invalid interval', 1);
    if (!o._.length) return reportErr(c, 'watch: no command specified', 1);
    const src = o._.map(quote).join(' ');
    for (let i = 0; i < 2; i++) {
      if (!o.t) c.out('\x1b[2J\x1b[H');
      if (!o.t) c.out(`Every ${sec.toFixed(1)}s: ${src}\n\n`);
      const session = c.spawn(src);
      const piping = pipeChannels(session, c);
      await session.done;
      await piping;
      if (i === 0) await sleepMs(Math.min(sec * 1000, 250));
    }
    return 0;
  });

  /* ------------------------------ kernel & service tools ------------------------------ */
  function bootLog(kernel) {
    const m = kernel.memoryInfo();
    return [
      { level: 'info', t: 0.0, msg: `Linux version ${REL} (webos@build) (gcc version 13.2.0) #1 SMP PREEMPT_DYNAMIC` },
      { level: 'info', t: 0.0, msg: `Command line: webos.boot=1 console=tty1 quiet` },
      { level: 'info', t: 0.0001, msg: `BIOS-provided physical RAM map: usable ${humanSize(m.total)}` },
      { level: 'info', t: 0.0002, msg: `CPU0: ${MACHINE} Virtual CPU @ 2.40GHz` },
      { level: 'info', t: 0.0004, msg: `SMP: Total of ${NCPU} processors activated.` },
      { level: 'info', t: 0.0012, msg: `Memory: ${Math.round(m.total / 1024)}K/${Math.round(m.total / 1024)}K available` },
      { level: 'info', t: 0.0021, msg: `loop: module loaded` },
      { level: 'info', t: 0.0024, msg: `loop0: detected capacity change from 0 to 8388608` },
      { level: 'info', t: 0.0033, msg: `EXT4-fs (loop0): mounted filesystem with ordered data mode. Quota mode: none.` },
      { level: 'info', t: 0.0102, msg: `systemd[1]: systemd 254 running in system mode (+PAM +AUDIT +SELINUX)` },
      { level: 'info', t: 0.0140, msg: `systemd[1]: Detected virtualization webos.` },
      { level: 'info', t: 0.0150, msg: `systemd[1]: Hostname set to <${kernel.hostname}>.` },
      { level: 'warn', t: 0.0180, msg: `ACPI: BIOS age (2026) fails cutoff (2000), acpi=force is required to enable ACPI` },
      { level: 'info', t: 0.0210, msg: `systemd[1]: Reached target Multi-User System.` },
      { level: 'info', t: 0.0211, msg: `systemd[1]: Startup finished in ${(kernel.uptime * 1000).toFixed(0)}ms.` },
    ];
  }

  reg(ctx, 'dmesg', 'print or control the kernel ring buffer', async (c) => {
    const o = parseOpts(c.args, 'Tl:n:', { human: 'T', level: 'l:', consolelevel: 'n:' });
    const levels = o.l ? String(o.l).split(',') : null;
    for (const e of bootLog(kernel)) {
      if (levels && !levels.includes(e.level)) continue;
      const stamp = o.T
        ? `[${new Date(kernel.bootTime + e.t * 1000).toUTCString()}]`
        : `[${(e.t).toFixed(6).padStart(12)}]`;
      c.out(`${stamp} ${e.msg}\n`);
    }
    return 0;
  });

  reg(ctx, 'journalctl', 'query the systemd journal (synthesized)', async (c) => {
    const o = parseOpts(c.args, 'n:u:p:bkr', {
      lines: 'n:', unit: 'u:', priority: 'p:', boot: 'b', reverse: 'r', 'no-pager': 'nopager', 'no-hostname': 'nohost',
    });
    const entries = [
      { t: 0.02, unit: 'kernel', prio: 6, msg: `Linux version ${REL} (webos@build)` },
      { t: 0.10, unit: 'systemd', prio: 6, msg: 'systemd 254 running in system mode' },
      { t: 0.16, unit: 'systemd', prio: 6, msg: `Hostname set to <${kernel.hostname}>` },
      { t: 0.21, unit: 'webos-init', prio: 6, msg: 'WebOS init reached multi-user target' },
      { t: 0.30, unit: 'dbus', prio: 6, msg: 'Successfully activated service org.freedesktop.DBus' },
      { t: 0.41, unit: 'cron', prio: 6, msg: '(root) WRONG FILE OWNER (crontab)' },
      { t: 1.02, unit: 'webos-shell', prio: 6, msg: 'shell session started on /dev/tty1' },
      { t: 2.10, unit: 'kernel', prio: 4, msg: 'loop0: partition scan complete' },
    ];
    const prioOrder = { 0: 'emerg', 1: 'alert', 2: 'crit', 3: 'err', 4: 'warning', 5: 'notice', 6: 'info', 7: 'debug' };
    let list = entries.slice();
    if (o.u) {
      const unit = String(o.u).replace(/\.service$/, '');
      list = list.filter((e) => e.unit === unit);
      if (!list.length) { c.out('-- No entries --\n'); return 0; }
    }
    if (o.p) {
      const max = Number(String(o.p).replace(/[^0-9]/g, '')) || 6;
      list = list.filter((e) => e.prio <= max);
    }
    if (o.n != null) list = list.slice(-Math.max(1, Number(o.n) || 10));
    if (o.r) list.reverse();
    for (const e of list) {
      const d = new Date(kernel.bootTime + e.t * 1000);
      const stamp = `${d.toString().slice(4, 7)} ${String(d.getDate()).padStart(2, ' ')} ${d.toTimeString().slice(0, 8)}`;
      c.out(`${stamp} ${kernel.hostname} ${e.unit === 'kernel' ? 'kernel' : e.unit + '[1]'}: ${e.msg}\n`);
    }
    if (!list.length) c.out('-- No entries --\n');
    if (!o.nohost && o.b) c.out(`-- Boot ${new Date(kernel.bootTime).toISOString()} --\n`);
    void prioOrder;
    return 0;
  });

  reg(ctx, 'mount', 'show mounts or mount a filesystem (listing only)', async (c) => {
    const o = parseOpts(c.args, 't:o:', { types: 't:', options: 'o:', readonly: 'r' });
    if (o._.length) {
      return reportErr(c, 'mount: mounting filesystems is not supported in the browser sandbox (no mount(2)); only /proc/mounts can be inspected', 32);
    }
    const mounts = etcText(c, '/proc/mounts', '/dev/loop0 / ext4 rw,relatime 0 0\nproc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\nsysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0\ntmpfs /tmp tmpfs rw,nosuid,nodev 0 0\n');
    const types = o.t ? String(o.t).split(',') : null;
    for (const line of mounts.split('\n').filter(Boolean)) {
      const [dev, mp, type, opts] = line.split(' ');
      if (types && !types.includes(type)) continue;
      c.out(`${dev} on ${mp} type ${type} (${opts})\n`);
    }
    return 0;
  });

  reg(ctx, 'umount', 'unmount file systems (not supported)', async (c) => {
    const target = c.args.find((a) => !a.startsWith('-'));
    return reportErr(c, `umount: cannot unmount ${target || 'filesystem'}: unmounting is not supported in the browser sandbox`, 32);
  });

  reg(ctx, 'fdisk', 'manipulate disk partition table (read-only fake)', async (c) => {
    const o = parseOpts(c.args, 'l', { list: 'l' });
    if (!o.l) return reportErr(c, 'fdisk: interactive partitioning is not supported in the browser sandbox');
    c.out(`Disk /dev/loop0: 8 GiB, 8589934592 bytes, 16777216 sectors\nUnits: sectors of 1 * 512 = 512 bytes\nSector size (logical/physical): 512 bytes / 512 bytes\nI/O size (minimum/optimal): 512 bytes / 512 bytes\nDisklabel type: dos\nDisk identifier: 0x5e0b5e0b\n\nDevice       Boot Start      End  Sectors Size Id Type\n/dev/loop0p1       2048 16777215 16775168   8G 83 Linux\n`);
    return 0;
  });

  reg(ctx, 'blkid', 'locate/print block device attributes', async (c) => {
    c.out('/dev/loop0: UUID="5e0b5e0b-0000-4000-8000-000000000001" TYPE="ext4"\n');
    c.out('/dev/loop0p1: PARTUUID="5e0b5e0b-01"\n');
    return 0;
  });

  for (const [cmd, on] of [['swapon', true], ['swapoff', false]]) {
    reg(ctx, cmd, 'enable/disable devices for paging and swapping (fake)', async (c) => {
      const o = parseOpts(c.args, 'as', { all: 'a', summary: 's' });
      if (o.s || (!o._.length && on)) {
        c.out('NAME      TYPE       SIZE USED PRIO\n');
        return 0;
      }
      if (!o._.length) return 0;
      return reportErr(c, `${cmd}: ${c.args[0]}: swap is not supported in the browser sandbox (no swap subsystem)`, 1);
    });
  }

  function sysctlMap(kernel) {
    return {
      'kernel.ostype': 'Linux',
      'kernel.osrelease': REL,
      'kernel.hostname': kernel.hostname,
      'kernel.pid_max': '4194304',
      'kernel.threads-max': '63445',
      'kernel.printk': '4\t4\t1\t7',
      'vm.swappiness': '60',
      'vm.dirty_ratio': '20',
      'fs.file-max': '9223372036854775807',
      'fs.protected_hardlinks': '1',
      'net.ipv4.ip_forward': '0',
      'net.ipv4.conf.all.rp_filter': '2',
    };
  }

  reg(ctx, 'sysctl', 'configure kernel parameters at runtime', async (c) => {
    const o = parseOpts(c.args, 'apnw', { all: 'a', write: 'w', values: 'n', pattern: 'p' });
    const map = sysctlMap(kernel);
    if (!(kernel.sysctl instanceof Map)) kernel.sysctl = new Map(Object.entries(map));
    const store = kernel.sysctl;
    if (o.a) {
      for (const k of Object.keys(map)) c.out(`${k} = ${store.get(k) ?? map[k]}\n`);
      return 0;
    }
    if (o.w) {
      if (!isRoot(c)) return reportErr(c, 'sysctl: setting key "sysctl": Permission denied');
      for (const kv of o._) {
        const i = kv.indexOf('=');
        if (i < 0) return reportErr(c, `sysctl: invalid argument '${kv}'`);
        const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
        store.set(k, v);
        if (k === 'kernel.hostname') {
          kernel.hostname = v;
          try { writeEtc(c, '/etc/hostname', v + '\n'); } catch { /* ignore */ }
        }
      }
      return 0;
    }
    let exit = 0;
    for (const k of o._) {
      const v = store.get(k) ?? map[k];
      if (v === undefined) { c.err(`sysctl: cannot stat /proc/sys/${k.replace(/\./g, '/')}: No such file or directory\n`); exit = 1; continue; }
      c.out(`${k} = ${v}\n`);
    }
    if (!o._.length) c.err('sysctl: no variables specified (use -a to list all)\n');
    return exit;
  });

  reg(ctx, 'lsmod', 'show the status of modules in the Linux kernel', async (c) => {
    c.out('Module                  Size  Used by\n');
    return 0;
  });

  reg(ctx, 'modprobe', 'add and remove kernel modules (simulated)', async (c) => {
    const known = ['loop', 'ext4', 'sr_mod', 'virtio_net', 'virtio_pci', 'usbhid', 'vfat', 'nls_utf8'];
    const args = c.args.filter((a) => !a.startsWith('-'));
    if (!args.length) return reportErr(c, 'modprobe: missing module name', 1);
    for (const name of args) {
      if (!known.includes(name)) return reportErr(c, `modprobe: FATAL: Module ${name} not found in directory /lib/modules/${REL}`, 1);
    }
    return 0;
  });

  reg(ctx, 'insmod', 'insert a module into the Linux kernel', async (c) => {
    return reportErr(c, `insmod: ERROR: failed to insert module '${c.args[0] || ''}': Operation not permitted (no kernel module loader in the browser sandbox)`, 1);
  });

  reg(ctx, 'rmmod', 'remove a module from the Linux kernel', async (c) => {
    return reportErr(c, `rmmod: ERROR: Module ${c.args[0] || ''} is not currently loaded (no kernel module loader in the browser sandbox)`, 1);
  });

  reg(ctx, 'depmod', 'generate modules.dep and map files', async (c) => 0);
  reg(ctx, 'ldconfig', 'configure dynamic linker run-time bindings', async (c) => 0);

  reg(ctx, 'update-rc.d', 'install and remove System-V style init script links (simulated)', async (c) => {
    if (c.args.length < 2) return reportErr(c, 'update-rc.d: usage: update-rc.d NAME ACTION', 1);
    const [name, action] = c.args;
    c.out(`update-rc.d: ${action} ${name}: simulated (WebOS uses systemctl-like services)\n`);
    return 0;
  });

  reg(ctx, 'crontab', 'maintain crontab files for individual users', async (c) => {
    const o = parseOpts(c.args, 'leru:', { list: 'l', edit: 'e', remove: 'r', user: 'u:' });
    const target = o.u || userName(kernel, c.uid);
    if (o.u && !isRoot(c) && target !== userName(kernel, c.uid)) return reportErr(c, 'crontab: Permission denied');
    const dir = '/var/spool/cron/crontabs';
    const path = `${dir}/${target}`;
    if (o.e) return reportErr(c, 'crontab: editing is not supported in a non-interactive session (no EDITOR/TTY)');
    if (o.r) {
      try { c.vfs.unlink(path, c.cred()); } catch { /* ignore */ }
      return 0;
    }
    if (o.l) {
      try { c.out(readTextFile(c, path)); return 0; }
      catch { return reportErr(c, `no crontab for ${target}`); }
    }
    let text;
    if (o._[0] && o._[0] !== '-') {
      try { text = readTextFile(c, o._[0]); } catch (e) { return reportErr(c, `crontab: ${o._[0]}: ${errnoText(e)}`); }
    } else {
      text = dec.decode(await c.readBytes());
    }
    try {
      c.vfs.mkdirp(dir, c.cred(), 0o1730);
      writeEtc(c, path, text, 0o600);
    } catch (e) { return reportErr(c, `crontab: ${errnoText(e)}`); }
    return 0;
  });

  reg(ctx, 'at', 'queue, examine or delete jobs for later execution (unsupported)', async (c) => {
    return reportErr(c, 'at: atd is not running in the browser sandbox; scheduled jobs cannot be queued. Use `sleep`/`timeout` for foreground delays.', 1);
  });
  reg(ctx, 'atq', 'list the user\'s pending jobs', async (c) => 0);
  reg(ctx, 'atrm', 'remove jobs', async (c) => reportErr(c, 'atrm: no atd in the browser sandbox', 1));

  function servicesOf(kernel) {
    if (!(kernel.services instanceof Map)) {
      kernel.services = new Map();
      const defs = [
        ['webos-init.service', 'WebOS init system', 'loaded', 'active', 'running', true],
        ['webos-shell.service', 'WebOS shell session', 'loaded', 'active', 'running', true],
        ['dbus.service', 'D-Bus System Message Bus', 'loaded', 'active', 'running', true],
        ['networking.service', 'Raise network interfaces', 'loaded', 'active', 'exited', true],
        ['cron.service', 'Regular background program processing daemon', 'loaded', 'inactive', 'dead', false],
        ['ssh.service', 'OpenBSD Secure Shell server', 'loaded', 'inactive', 'dead', false],
      ];
      for (const [name, desc, load, active, sub, enabled] of defs) {
        kernel.services.set(name, { name, desc, load, active, sub, enabled });
      }
    }
    return kernel.services;
  }

  function findUnit(kernel, name) {
    const map = servicesOf(kernel);
    if (!name) return null;
    return map.get(name) || map.get(name + '.service') || null;
  }

  function unitLabel(name) { return name.includes('.') ? name : name + '.service'; }

  function statusUnit(c, u) {
    if (!u) return 4;
    c.out(`● ${u.name} - ${u.desc}\n`);
    c.out(`     Loaded: ${u.load} (/lib/systemd/system/${u.name}; ${u.enabled ? 'enabled' : 'disabled'}; preset: enabled)\n`);
    c.out(`     Active: ${u.active} (${u.sub})\n`);
    c.out(`       Docs: man:${u.name}(8)\n`);
    return u.active === 'active' ? 0 : 3;
  }

  reg(ctx, 'systemctl', 'control the systemd system and service manager (simulated)', async (c) => {
    const o = parseOpts(c.args, '', { 'no-pager': 'nopager', all: 'all', quiet: 'quiet' });
    const verb = o._[0];
    const arg = o._[1];
    const units = servicesOf(kernel);
    if (!verb) {
      c.out('  UNIT                     LOAD   ACTIVE SUB     DESCRIPTION\n');
      for (const u of units.values()) {
        c.out(`  ${pad(u.name, 24)} ${pad(u.load, 6)} ${pad(u.active, 6)} ${pad(u.sub, 7)} ${u.desc}\n`);
      }
      c.out('\nLOAD   = Reflects whether the unit definition was properly loaded.\n');
      return 0;
    }
    if (verb === 'list-units') {
      c.out('  UNIT                     LOAD   ACTIVE SUB     DESCRIPTION\n');
      for (const u of units.values()) {
        if (arg && !wildcardMatch(arg, u.name)) continue;
        if (!o.all && u.active !== 'active') continue;
        c.out(`  ${pad(u.name, 24)} ${pad(u.load, 6)} ${pad(u.active, 6)} ${pad(u.sub, 7)} ${u.desc}\n`);
      }
      return 0;
    }
    if (verb === 'list-unit-files') {
      c.out('UNIT FILE                STATE    PRESET\n');
      for (const u of units.values()) c.out(`${pad(u.name, 24)} ${pad(u.enabled ? 'enabled' : 'disabled', 8)} enabled\n`);
      return 0;
    }
    if (verb === 'daemon-reload' || verb === 'reset-failed') return 0;
    if (verb === 'status') {
      if (!arg) {
        const running = [...units.values()].filter((u) => u.active === 'active').length;
        c.out(`● ${kernel.hostname}\n    State: running\n     Jobs: 0 queued\n   Failed: 0 units\n    Since: ${fmtDate(kernel.bootTime, { long: true })}\n   Units: ${units.size} loaded, ${running} active\n`);
        return 0;
      }
      const u = findUnit(kernel, arg);
      if (!u) { c.err(`Unit ${unitLabel(arg)} could not be found.\n`); return 4; }
      return statusUnit(c, u);
    }
    if (verb === 'is-active') {
      const u = findUnit(kernel, arg);
      const active = u && u.active === 'active';
      c.out((active ? 'active' : u ? u.active : 'inactive') + '\n');
      return active ? 0 : 3;
    }
    if (verb === 'is-enabled') {
      const u = findUnit(kernel, arg);
      c.out((u && u.enabled ? 'enabled' : 'disabled') + '\n');
      return u && u.enabled ? 0 : 1;
    }
    if (['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask'].includes(verb)) {
      const u = findUnit(kernel, arg);
      if (!u) {
        c.err(`Failed to ${verb} ${unitLabel(arg)}: Unit ${unitLabel(arg)} not found.\n`);
        return 5;
      }
      if (verb === 'start' || verb === 'restart' || verb === 'reload') { u.active = 'active'; u.sub = 'running'; }
      if (verb === 'stop') { u.active = 'inactive'; u.sub = 'dead'; }
      if (verb === 'enable') u.enabled = true;
      if (verb === 'disable') u.enabled = false;
      return 0;
    }
    return reportErr(c, `systemctl: unknown command verb '${verb}'`, 1);
  });

  function wildcardMatch(pat, str) {
    const rx = new RegExp('^' + [...pat].map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : '\\' + ch)).join('') + '$');
    return rx.test(str);
  }

  reg(ctx, 'service', 'run a System V init script (systemctl alias)', async (c) => {
    const units = servicesOf(kernel);
    if (c.args.includes('--status-all')) {
      for (const u of units.values()) c.out(` [ ${u.active === 'active' ? '+' : '-'} ]  ${u.name.replace(/\.service$/, '')}\n`);
      return 0;
    }
    const [name, action] = c.args;
    if (!name || !action) return reportErr(c, 'service: usage: service NAME ACTION', 1);
    const u = findUnit(kernel, name);
    if (!u) return reportErr(c, `service: ${name}: unrecognized service`, 1);
    if (action === 'status') {
      c.out(`● ${u.name} - ${u.desc}\n     Active: ${u.active} (${u.sub})\n`);
      return u.active === 'active' ? 0 : 3;
    }
    if (['start', 'restart', 'reload', 'force-reload'].includes(action)) { u.active = 'active'; u.sub = 'running'; return 0; }
    if (action === 'stop') { u.active = 'inactive'; u.sub = 'dead'; return 0; }
    return reportErr(c, `service: ${name}: unknown action '${action}'`, 1);
  });

  reg(ctx, 'runlevel', 'print previous and current System V runlevel', async (c) => {
    c.out('N 5\n');
    return 0;
  });

  for (const [cmd, label] of [['reboot', 'reboot'], ['poweroff', 'power off'], ['halt', 'halt']]) {
    reg(ctx, cmd, `${label} the system (simulated)`, async (c) => {
      kernel.running = false;
      c.out(`${label}: system ${label} requested (simulated; the browser sandbox stays alive)\n`);
      return 0;
    });
  }

  reg(ctx, 'shutdown', 'shut down or restart the system (simulated)', async (c) => {
    const o = parseOpts(c.args, 'r h P c k t:', {
      reboot: 'r', halt: 'h', poweroff: 'P', cancel: 'c', kill: 'k', time: 't:',
    });
    void o;
    if (c.args.includes('-c')) { c.out('shutdown: cancelled (no pending shutdown)\n'); return 0; }
    const mode = c.args.includes('-r') ? 'reboot' : c.args.includes('-h') || c.args.includes('-P') ? 'power off' : 'shut down';
    kernel.running = false;
    c.err(`Shutdown scheduled for now (${mode}). This is simulated: the browser sandbox cannot power off the host.\n`);
    return 0;
  });

  reg(ctx, 'init', 'change the system runlevel (simulated)', async (c) => {
    const level = c.args[0];
    if (!level) return reportErr(c, 'init: usage: init [0-6]', 1);
    if (level === '0' || level === '6') {
      kernel.running = false;
      c.out(`init: runlevel ${level}: system ${level === '0' ? 'halt' : 'reboot'} simulated (the browser sandbox stays alive)\n`);
      return 0;
    }
    return reportErr(c, `init: switching to runlevel ${level} is not supported in the browser sandbox`, 1);
  });

  /* ------------------------------ bc / dc ------------------------------ */
  class Dec {
    constructor(d, s) { this.d = d; this.s = s; }
    static norm(d, s) {
      while (s > 0 && d % 10n === 0n) { d /= 10n; s--; }
      return new Dec(d, s);
    }
    static parse(str, ibase = 10) {
      let s = String(str).trim();
      let neg = false;
      if (s[0] === '+') s = s.slice(1);
      else if (s[0] === '-') { neg = true; s = s.slice(1); }
      if (!s || !/^[0-9A-Za-z]*(\.[0-9A-Za-z]*)?$/.test(s) || s === '.') throw new Error(`invalid number '${str}'`);
      let [ip = '', fp = ''] = s.split('.');
      ip = ip || '0';
      const digit = (ch) => {
        const v = parseInt(ch, 36);
        if (Number.isNaN(v) || v >= ibase) throw new Error(`invalid digit '${ch}' for base ${ibase}`);
        return v;
      };
      let d;
      if (ibase === 10) {
        d = BigInt((ip + fp).replace(/^0+(?=\d)/, '') || '0');
        return Dec.norm(neg ? -d : d, fp.length);
      }
      let intVal = 0n;
      for (const ch of ip) intVal = intVal * BigInt(ibase) + BigInt(digit(ch));
      let fracVal = 0n;
      for (const ch of fp) fracVal = fracVal * BigInt(ibase) + BigInt(digit(ch));
      const target = 20;
      let num = intVal * (BigInt(ibase) ** BigInt(fp.length)) + fracVal;
      let den = BigInt(ibase) ** BigInt(fp.length);
      d = (num * (10n ** BigInt(target))) / den;
      return Dec.norm(neg ? -d : d, target);
    }
    static int(n) { return new Dec(BigInt(n), 0); }
    neg() { return new Dec(-this.d, this.s); }
    add(o) {
      const s = Math.max(this.s, o.s);
      return Dec.norm(this.d * 10n ** BigInt(s - this.s) + o.d * 10n ** BigInt(s - o.s), s);
    }
    sub(o) { return this.add(o.neg()); }
    mul(o) { return Dec.norm(this.d * o.d, this.s + o.s); }
    div(o, scale) {
      if (o.d === 0n) throw new Error('Division by zero');
      let num = this.d, den = o.d;
      const e = o.s - this.s + scale;
      if (e >= 0) num *= 10n ** BigInt(e); else den *= 10n ** BigInt(-e);
      return Dec.norm(num / den, scale);
    }
    mod(o) {
      if (o.d === 0n) throw new Error('Division by zero');
      return this.sub(this.div(o, 0).mul(o));
    }
    pow(o) {
      if (o.s !== 0) throw new Error('non-integer exponent');
      const e = Number(o.d);
      if (!Number.isSafeInteger(e) || Math.abs(e) > 100000) throw new Error('exponent too large');
      let result = Dec.int(1);
      let base = this;
      let n = Math.abs(e);
      while (n > 0) {
        if (n & 1) result = result.mul(base);
        base = base.mul(base);
        n >>= 1;
      }
      return e < 0 ? Dec.int(1).div(result, 20) : result;
    }
    sqrt(scale) {
      if (this.d < 0n) throw new Error('negative number');
      let num = this.d;
      const e = 2 * scale - this.s;
      if (e >= 0) num *= 10n ** BigInt(e); else num /= 10n ** BigInt(-e);
      let x = num, y = (x + 1n) / 2n;
      while (y < x) { x = y; y = (x + num / x) / 2n; }
      return Dec.norm(x, scale);
    }
    cmp(o) {
      const s = Math.max(this.s, o.s);
      const a = this.d * 10n ** BigInt(s - this.s), b = o.d * 10n ** BigInt(s - o.s);
      return a < b ? -1 : a > b ? 1 : 0;
    }
    toString(obase = 10) {
      const neg = this.d < 0n;
      let abs = neg ? -this.d : this.d;
      let out;
      if (obase === 10) {
        let digits = abs.toString();
        if (this.s > 0) {
          digits = digits.padStart(this.s + 1, '0');
          digits = digits.slice(0, digits.length - this.s) + '.' + digits.slice(digits.length - this.s);
        }
        out = digits;
      } else {
        const den = 10n ** BigInt(this.s);
        let intPart = abs / den;
        let frac = abs % den;
        const digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let ip = '';
        if (intPart === 0n) ip = '0';
        while (intPart > 0n) { ip = digits[Number(intPart % BigInt(obase))] + ip; intPart /= BigInt(obase); }
        let fp = '';
        for (let i = 0; i < this.s && frac > 0n; i++) {
          frac *= BigInt(obase);
          fp += digits[Number(frac / den)];
          frac %= den;
        }
        out = fp ? `${ip}.${fp}` : ip;
      }
      return (neg && out !== '0' ? '-' : '') + out;
    }
  }

  function tokenizeBc(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (ch === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (/[0-9A-Za-z_.]/.test(ch)) {
        let j = i;
        while (j < src.length && /[0-9A-Za-z_.]/.test(src[j])) j++;
        out.push(src.slice(i, j));
        i = j;
        continue;
      }
      const two = src.slice(i, i + 2);
      if (['==', '!=', '<=', '>='].includes(two)) { out.push(two); i += 2; continue; }
      if ('+-*/%^()<>=!;,'.includes(ch)) { out.push(ch); i++; continue; }
      throw new Error(`syntax error near '${ch}'`);
    }
    return out;
  }

  function evalBcStatement(stmt, settings, c) {
    const toks = tokenizeBc(stmt);
    if (!toks.length) return;
    let pos = 0;
    const peek = () => toks[pos];
    const next = () => toks[pos++];
    const isNum = (t) => {
      if (t == null) return false;
      if (/^\d+(\.\d*)?$/.test(t) || /^\.\d+$/.test(t)) return true;
      if (/^[0-9A-Fa-f]+(\.[0-9A-Fa-f]*)?$/.test(t) && settings.ibase > 10) {
        return [...t.replace('.', '')].every((ch) => parseInt(ch, 36) < settings.ibase);
      }
      return false;
    };
    const primary = () => {
      const t = next();
      if (t == null) throw new Error('syntax error: unexpected end of input');
      if (isNum(t)) return Dec.parse(t, settings.ibase);
      if (t === '(') {
        const v = expr();
        if (next() !== ')') throw new Error('missing `)`');
        return v;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
        if (peek() === '(') {
          next();
          const arg = expr();
          if (next() !== ')') throw new Error('missing `)`');
          if (t === 'sqrt') return arg.sqrt(settings.scale);
          if (t === 'abs') return arg.d < 0n ? arg.neg() : arg;
          throw new Error(`undefined function '${t}'`);
        }
        if (t === 'scale') return Dec.int(settings.scale);
        if (t === 'ibase') return Dec.int(settings.ibase);
        if (t === 'obase') return Dec.int(settings.obase);
        return settings.vars.get(t) || Dec.int(0);
      }
      throw new Error(`syntax error near '${t}'`);
    };
    const power = () => {
      let base = primary();
      while (peek() === '^') { next(); base = base.pow(unary()); }
      return base;
    };
    const unary = () => {
      if (peek() === '-') { next(); return unary().neg(); }
      if (peek() === '+') { next(); return unary(); }
      return power();
    };
    const mul = () => {
      let v = unary();
      for (;;) {
        const op = peek();
        if (op !== '*' && op !== '/' && op !== '%') return v;
        next();
        const r = unary();
        v = op === '*' ? v.mul(r) : op === '/' ? v.div(r, settings.scale) : v.mod(r);
      }
    };
    const add = () => {
      let v = mul();
      for (;;) {
        const op = peek();
        if (op !== '+' && op !== '-') return v;
        next();
        v = op === '+' ? v.add(mul()) : v.sub(mul());
      }
    };
    const compare = () => {
      let v = add();
      for (;;) {
        const op = peek();
        if (!['==', '!=', '<', '>', '<=', '>='].includes(op)) return v;
        next();
        const r = add();
        const cmp = v.cmp(r);
        const truth = op === '==' ? cmp === 0 : op === '!=' ? cmp !== 0 : op === '<' ? cmp < 0 : op === '>' ? cmp > 0 : op === '<=' ? cmp <= 0 : cmp >= 0;
        v = Dec.int(truth ? 1 : 0);
      }
    };
    const expr = compare;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(peek()) && toks[pos + 1] === '=') {
      const name = next();
      next();
      const v = expr();
      if (name === 'scale') {
        const n = Number(v.toString(10));
        settings.scale = Math.max(0, Math.min(100, Math.trunc(n) || 0));
      } else if (name === 'ibase') {
        const n = Number(v.toString(10));
        if (!(n >= 2 && n <= 16)) throw new Error('ibase must be between 2 and 16');
        settings.ibase = n;
      } else if (name === 'obase') {
        const n = Number(v.toString(10));
        if (!(n >= 2 && n <= 36)) throw new Error('obase must be between 2 and 36');
        settings.obase = n;
      } else {
        settings.vars.set(name, v);
      }
      if (pos < toks.length) throw new Error(`syntax error near '${peek()}'`);
      return;
    }
    const v = expr();
    if (pos < toks.length) throw new Error(`syntax error near '${peek()}'`);
    c.out(v.toString(settings.obase) + '\n');
  }

  reg(ctx, 'bc', 'arbitrary precision decimal calculator', async (c) => {
    const o = parseOpts(c.args, 'lq', { mathlib: 'l', quiet: 'q' });
    void o;
    const src = c.args.includes('-e') || c.args.includes('--expression')
      ? String(c.args[c.args.indexOf(c.args.find((a) => a === '-e' || a === '--expression')) + 1])
      : o._.length ? o._.join(' ') : dec.decode(await c.readBytes());
    const settings = { scale: 0, ibase: 10, obase: 10, vars: new Map() };
    let exit = 0;
    for (const stmt of src.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
      try { evalBcStatement(stmt, settings, c); }
      catch (e) { c.err(`bc: ${e.message}\n`); exit = 1; break; }
    }
    return exit;
  });

  reg(ctx, 'dc', 'reverse-polish desk calculator (subset)', async (c) => {
    let src = '';
    const exprIdx = c.args.findIndex((a) => a === '-e' || a === '--expression');
    if (exprIdx >= 0 && c.args[exprIdx + 1] != null) src = c.args[exprIdx + 1];
    else src = c.args.length ? c.args.join(' ') : dec.decode(await c.readBytes());
    const stack = [];
    const settings = { scale: 0, ibase: 10, obase: 10 };
    const pop = () => { if (!stack.length) throw new Error('stack empty'); return stack.pop(); };
    const bin = (fn) => { const b = pop(), a = pop(); stack.push(fn(a, b)); };
    let exit = 0;
    let quit = false;
    for (let tok of src.split(/\s+/).filter(Boolean)) {
      try {
        if (tok.startsWith('_') && /^_[\d.]+$/.test(tok)) tok = '-' + tok.slice(1);
        if (/^-?\d+(\.\d*)?$/.test(tok) || /^-?\.\d+$/.test(tok)) { stack.push(Dec.parse(tok, settings.ibase)); continue; }
        switch (tok) {
          case '+': bin((a, b) => a.add(b)); break;
          case '-': bin((a, b) => a.sub(b)); break;
          case '*': bin((a, b) => a.mul(b)); break;
          case '/': bin((a, b) => a.div(b, settings.scale)); break;
          case '%': bin((a, b) => a.mod(b)); break;
          case '^': bin((a, b) => a.pow(b)); break;
          case 'v': stack.push(pop().sqrt(settings.scale)); break;
          case 'p': c.out(pop().toString(settings.obase) + '\n'); break;
          case 'n': c.out(pop().toString(settings.obase)); break;
          case 'P': c.out(pop().toString(settings.obase)); break;
          case 'f': for (let i = stack.length - 1; i >= 0; i--) c.out(stack[i].toString(settings.obase) + '\n'); break;
          case 'c': stack.length = 0; break;
          case 'd': stack.push(stack[stack.length - 1]); break;
          case 'r': { const b = pop(), a = pop(); stack.push(b, a); break; }
          case 'z': stack.push(Dec.int(stack.length)); break;
          case 'k': settings.scale = Math.max(0, Math.min(100, Number(pop().toString(10)) || 0)); break;
          case 'i': settings.ibase = Math.max(2, Math.min(16, Number(pop().toString(10)) || 10)); break;
          case 'o': settings.obase = Math.max(2, Math.min(36, Number(pop().toString(10)) || 10)); break;
          case 'q': quit = true; break;
          default: throw new Error(`syntax error near '${tok}'`);
        }
        if (quit) break;
      } catch (e) {
        c.err(`dc: ${e.message}\n`);
        exit = 1;
        break;
      }
    }
    return exit;
  });
}
