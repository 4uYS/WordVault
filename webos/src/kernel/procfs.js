/* Dynamic /proc filesystem. */

import { Inode } from './vfs.js';

const enc = new TextEncoder();
const file = (read, mode = 0o444) => new Inode('file', mode, { dynamic: { read } });
const dir = (names, getChild) => new Inode('dir', 0o555, { dynamic: { names, getChild } });

export function installProcfs(kernel) {
  const root = kernel.vfs.resolve('/proc', { uid: 0 }).node;

  const procFile = (pid, name) => {
    const p = kernel.getProcess(pid);
    const content = () => {
      if (!p) return '';
      const { uid } = p;
      switch (name) {
        case 'cmdline': return p.argv.join('\0') + '\0';
        case 'comm': return p.name.slice(0, 15) + '\n';
        case 'status':
          return `Name:\t${p.name}\nUmask:\t0022\nState:\t${p.state === 'Z' ? 'Z (zombie)' : 'R (running)'}\nTgid:\t${p.pid}\nPid:\t${p.pid}\nPPid:\t${p.ppid}\nUid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\nGid:\t${p.gid}\t${p.gid}\t${p.gid}\t${p.gid}\nThreads:\t1\nVmRSS:\t  ${Math.round(4096 + (p.cpu || 0) / 100)} kB\nvoluntary_ctxt_switches:\t0\nnonvoluntary_ctxt_switches:\t0\n`;
        case 'stat':
          return `${p.pid} (${p.name}) ${p.state} ${p.ppid} ${p.pgrp} ${p.sid} 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 ${Math.floor((p.started - kernel.bootTime) / 10)} 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n`;
        case 'environ': return Object.entries(p.env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0';
        case 'auxv': return '';
        case 'maps': return '00400000-00452000 r-xp 00000000 00:00 0  /bin/webos\n';
        case 'mountinfo': return kernel.vfs.constructor.name ? '' : '';
        default: return '';
      }
    };
    return file(() => enc.encode(content()));
  };

  const procDir = (pid) => {
    const p = kernel.getProcess(pid);
    const baseNames = ['cmdline', 'comm', 'status', 'stat', 'environ', 'maps', 'auxv', 'mountinfo'];
    return dir(
      () => [...baseNames, 'cwd', 'exe', 'root', 'fd'],
      (name, ctx) => {
        if (baseNames.includes(name)) return procFile(pid, name);
        if (name === 'cwd') return new Inode('symlink', 0o777, { target: () => p?.cwd || '/' });
        if (name === 'root') return new Inode('symlink', 0o777, { target: '/' });
        if (name === 'exe') return new Inode('symlink', 0o777, { target: () => (p?.argv?.[0]?.startsWith('/') ? p.argv[0] : '/bin/' + (p?.name || 'webos')) });
        if (name === 'fd') {
          if (!p) return null;
          return dir(() => [...p.fds.keys()].map(String), (fd, ctx) => {
            if (!p.fds.has(Number(fd))) return null;
            return new Inode('symlink', 0o777, { target: `/dev/fd/${fd}` });
          });
        }
        return null;
      },
    );
  };

  root.dynamic = {
    names() {
      const pids = [...kernel.procs.keys()].sort((a, b) => a - b).map(String);
      return ['self', 'thread-self', 'cpuinfo', 'meminfo', 'uptime', 'version', 'mounts', 'loadavg',
        'filesystems', 'devices', 'sys', 'net', 'tty', 'consoles', ...pids];
    },
    getChild(name, ctx = {}) {
      if (name === 'self') return new Inode('symlink', 0o777, { target: () => String(ctx.pid || 1) });
      if (name === 'thread-self') return procDir(ctx.pid || 1);
      if (/^\d+$/.test(name)) {
        if (!kernel.getProcess(Number(name))) return null;
        return procDir(Number(name));
      }
      if (name === 'cpuinfo') {
        const ncpu = Math.max(1, globalThis.navigator?.hardwareConcurrency || 4);
        return file(() => enc.encode(Array.from({ length: ncpu }, (_, i) =>
          `processor\t: ${i}\nvendor_id\t: GenuineWebOS\nmodel name\t: WebOS Virtual CPU ${i}\ncpu MHz\t: 2400.000\ncache size\t: 8192 KB\nflags\t\t: fpu vme de pse tsc msr pae mce cx8 apic\n\n`).join('')));
      }
      if (name === 'meminfo') {
        return file(() => {
          const m = kernel.memoryInfo();
          const kb = (n) => Math.round(n / 1024);
          return enc.encode(`MemTotal:       ${kb(m.total)} kB\nMemFree:        ${kb(m.free)} kB\nMemAvailable:   ${kb(m.free)} kB\nBuffers:        0 kB\nCached:         0 kB\nSwapTotal:      0 kB\nSwapFree:       0 kB\n`);
        });
      }
      if (name === 'uptime') {
        return file(() => enc.encode(`${kernel.uptime.toFixed(2)} ${(kernel.uptime * 0.9).toFixed(2)}\n`));
      }
      if (name === 'loadavg') return file(() => enc.encode('0.00 0.00 0.00 1/1 1\n'));
      if (name === 'version') return file(() => enc.encode('Linux version 6.1.0-webos (build@webos) (js 1.0) #1 SMP\n'));
      if (name === 'mounts') {
        return file(() => enc.encode([
          '/dev/root / ext2 rw,relatime 0 0',
          'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
          'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
          'devtmpfs /dev devtmpfs rw,nosuid,relatime,size=102400k 0 0',
          'tmpfs /tmp tmpfs rw,nosuid,nodev 0 0',
          'tmpfs /run tmpfs rw,nosuid,nodev,mode=755 0 0',
        ].join('\n') + '\n'));
      }
      if (name === 'filesystems') return file(() => enc.encode('nodev\tsysfs\nnodev\tproc\nnodev\ttmpfs\n\text2\n\text4\n\txfs\n\tbtrfs\n'));
      if (name === 'devices') return file(() => enc.encode('Character devices:\n  1 mem\n  4 /dev/tty\n  5 /dev/tty\n  5 /dev/console\n  1 /dev/null\n  1 /dev/zero\n  1 /dev/random\n  1 /dev/urandom\n'));
      if (name === 'tty') return new Inode('symlink', 0o777, { target: '/dev/tty' });
      if (name === 'consoles') return file(() => enc.encode('/dev/console\n'));
      if (name === 'sys') return dir(() => ['kernel'], (n) => n === 'kernel' ? dir(() => ['ostype', 'osrelease', 'hostname'],
        (k) => k === 'ostype' ? file(() => enc.encode('Linux\n'))
          : k === 'osrelease' ? file(() => enc.encode('6.1.0-webos\n'))
            : k === 'hostname' ? file(() => enc.encode(kernel.hostname + '\n')) : null) : null);
      if (name === 'net') return dir(() => ['dev'], (n) => n === 'dev' ? file(() => enc.encode('Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n')) : null);
      return null;
    },
  };
}
