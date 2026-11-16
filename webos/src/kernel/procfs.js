/* Dynamic /proc and /sys-style inspection files, generated from kernel state. */

import { Inode } from './vfs.js';
import { CAP_NAMES, RLIMITS } from './process.js';

const enc = new TextEncoder();
const file = (read, mode = 0o444) => new Inode('file', mode, { dynamic: { read } });
const wfile = (read, write, mode = 0o644) => new Inode('file', mode, { dynamic: { read, write } });
const dir = (names, getChild) => new Inode('dir', 0o555, { dynamic: { names, getChild } });
const kb = (n) => Math.round(n / 1024);

const STATE = { R: 'R (running)', S: 'S (sleeping)', Z: 'Z (zombie)', T: 'T (stopped)' };
const STATE_CHAR = { R: 'R', S: 'S', Z: 'Z', T: 'T' };

function mountText(kernel) {
  return kernel.vfs.mountsList().map((m) => {
    const opts = kernel.vfs.mountOptionText(m);
    return `${m.source || m.fstype} ${m.target} ${m.fstype} ${opts} 0 0`;
  }).join('\n') + '\n';
}

function capHex(mask) {
  return (mask ?? 0n).toString(16).padStart(16, '0');
}

export function installProcfs(kernel) {
  const root = kernel.vfs.resolve('/proc', { uid: 0 }).node;

  const procFile = (pid, name) => {
    const p = () => kernel.getProcess(pid);
    const content = () => {
      const proc = p();
      if (!proc) return '';
      switch (name) {
        case 'cmdline': return proc.argv.join('\0') + '\0';
        case 'comm': return proc.name.slice(0, 15) + '\n';
        case 'status': {
          const mem = kernel.memoryInfo();
          return `Name:\t${proc.name}\nUmask:\t${(proc.umask ?? 0o022).toString(8).padStart(4, '0')}\nState:\t${STATE[proc.state] || 'S (sleeping)'}\n`
            + `Tgid:\t${proc.pid}\nPid:\t${proc.pid}\nPPid:\t${proc.ppid}\nTracerPid:\t0\n`
            + `Uid:\t${proc.uid}\t${proc.uid}\t${proc.uid}\t${proc.uid}\nGid:\t${proc.gid}\t${proc.gid}\t${proc.gid}\t${proc.gid}\n`
            + `Groups:\t${(proc.groups || []).join(' ')}\n`
            + `CapEff:\t${capHex(proc.caps)}\nCapPrm:\t${capHex(proc.caps)}\nCapBnd:\tffffffffffffffff\n`
            + `NoNewPrivs:\t0\nSeccomp:\t0\nThreads:\t1\n`
            + `VmPeak:\t  ${kb(4096 + (proc.cpu || 0) / 100)} kB\nVmSize:\t  ${kb(4096 + (proc.cpu || 0) / 100)} kB\n`
            + `VmRSS:\t  ${kb(2048 + (proc.cpu || 0) / 100)} kB\n`
            + `voluntary_ctxt_switches:\t${proc.nvcsw || 0}\nnonvoluntary_ctxt_switches:\t${proc.nivcsw || 0}\n`;
        }
        case 'stat':
          return `${proc.pid} (${proc.name}) ${STATE_CHAR[proc.state] || 'S'} ${proc.ppid} ${proc.pgrp} ${proc.sid} 0 -1 0 0 0 0 0 0 0 0 20 ${proc.nice} 1 0 ${Math.floor((proc.started - kernel.bootTime) / 10)} 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n`;
        case 'statm': {
          const pages = Math.ceil((2048 + (proc.cpu || 0) / 100) / 4);
          return `${pages} ${pages} 1 0 0 ${pages} 0\n`;
        }
        case 'environ': return Object.entries(proc.env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0';
        case 'auxv': return '';
        case 'maps': return '00400000-00452000 r-xp 00000000 00:00 0  /bin/webos\n7f0000000000-7f0000001000 rw-p 00000000 00:00 0  [heap]\n';
        case 'mountinfo':
          return kernel.vfs.mountsList().map((m) => `${m.id} 1 0:${m.id} ${m.target} ${m.target} ${m.fstype} ${kernel.vfs.mountOptionText(m)} - ${m.source} ${m.fstype} ${Object.entries(m.options).map(([k, v]) => `${k}=${v}`).join(',')} 0 0`).join('\n') + '\n';
        case 'mounts': return mountText(kernel);
        case 'limits': {
          const names = Object.fromEntries(Object.entries(RLIMITS).map(([k, v]) => [v, k]));
          const units = { 0: 'seconds', 6: 'processes', 7: 'files', 10: 'locks', 11: 'signals', 13: '', 14: '' };
          return 'Limit                     Soft Limit           Hard Limit           Units\n'
            + [...proc.rlimits.entries()].map(([res, [soft, hard]]) =>
              `${names[res] || `RLIMIT_${res}`.padEnd(25)} ${String(soft === Infinity ? 'unlimited' : soft).padEnd(20)} ${String(hard === Infinity ? 'unlimited' : hard).padEnd(20)} ${units[res] ?? 'bytes'}`).join('\n') + '\n';
        }
        case 'cgroup': return `0::/user.slice/user-${proc.uid}.slice/session-${proc.sid}.scope\n`;
        case 'oom_score': return `${proc.uid === 0 ? 0 : 200}\n`;
        case 'oom_score_adj': return '0\n';
        case 'wchan': return proc.state === 'Z' ? 'do_exit\n' : '0\n';
        case 'children': return kernel.allChildren(proc.pid).map((c) => c.pid).join(' ') + '\n';
        case 'sched': return `webos (${proc.pid}, #threads: 1)\nse.exec_start : ${(proc.started - kernel.bootTime) * 1e6}\nse.nr_migrations : 0\n`;
        case 'io': return `rchar: ${proc.bytesIn || 0}\nwchar: ${proc.bytesOut || 0}\nsyscr: 0\nsyscw: 0\nread_bytes: 0\nwrite_bytes: 0\ncancelled_write_bytes: 0\n`;
        default: return '';
      }
    };
    return file(() => enc.encode(content()));
  };

  const procDir = (pid) => {
    const baseNames = ['cmdline', 'comm', 'status', 'stat', 'statm', 'environ', 'maps', 'auxv',
      'mountinfo', 'mounts', 'limits', 'cgroup', 'oom_score', 'oom_score_adj', 'wchan',
      'children', 'sched', 'io'];
    return dir(
      () => [...baseNames, 'cwd', 'exe', 'root', 'fd', 'task'],
      (name, ctx) => {
        const p = kernel.getProcess(pid);
        if (baseNames.includes(name)) return procFile(pid, name);
        if (name === 'cwd') return new Inode('symlink', 0o777, { target: () => p?.cwd || '/' });
        if (name === 'root') return new Inode('symlink', 0o777, { target: () => p?.root || '/' });
        if (name === 'exe') return new Inode('symlink', 0o777, { target: () => (p?.argv?.[0]?.startsWith('/') ? p.argv[0] : '/bin/' + (p?.name || 'webos')) });
        if (name === 'fd') {
          if (!p) return null;
          return dir(() => [...p.fds.keys()].map(String), (fd) => {
            if (!p.fds.has(Number(fd))) return null;
            return new Inode('symlink', 0o777, { target: `pipe:[${1000 + Number(fd)}]` });
          });
        }
        if (name === 'fdinfo') {
          return dir(() => [...(p?.fds.keys() || [])].map(String), (fd) => {
            if (!p?.fds.has(Number(fd))) return null;
            return file(() => enc.encode(`pos:\t0\nflags:\t02\nmnt_id:\t0\nino:\t0\n`));
          });
        }
        if (name === 'task') {
          return dir(() => (p ? [String(p.pid)] : []), (tid) => (p && Number(tid) === p.pid ? procDir(pid) : null));
        }
        return null;
      },
    );
  };

  const sysKernel = dir(
    () => ['ostype', 'osrelease', 'osversion', 'hostname', 'version', 'pid_max', 'random', 'shmmax', 'shmall', 'msgmax', 'msgmnb', 'sem'],
    (name) => {
      switch (name) {
        case 'ostype': return file(() => enc.encode('Linux\n'));
        case 'osrelease': return file(() => enc.encode('6.6.0-webos\n'));
        case 'osversion': return file(() => enc.encode('#1 SMP WebOS-JS\n'));
        case 'version': return file(() => enc.encode('Linux version 6.6.0-webos (js@webos) #1 SMP\n'));
        case 'hostname': return wfile(
          () => enc.encode(kernel.hostname + '\n'),
          (bytes) => {
            const text = new TextDecoder().decode(bytes).trim();
            if (!text) throw new Error('EINVAL');
            kernel.setHostname(text);
          }, 0o644);
        case 'pid_max': return file(() => enc.encode(`${kernel.nextPid + 32768}\n`));
        case 'shmmax': return file(() => enc.encode('67108864\n'));
        case 'shmall': return file(() => enc.encode('16384\n'));
        case 'msgmax': return file(() => enc.encode('8192\n'));
        case 'msgmnb': return file(() => enc.encode('16384\n'));
        case 'sem': return file(() => enc.encode('32000\t32000\t32\t32000\n'));
        case 'random':
          return dir(() => ['boot_id', 'uuid'], (n) => file(() => enc.encode(
            n === 'boot_id' ? `${kernel.bootId}\n` : `${kernel.bootId.split('-')[0]}-${Date.now().toString(16)}\n`)));
        default: return null;
      }
    },
  );

  const sysNetIpv4 = dir(() => ['ip_forward', 'ip_local_port_range', 'tcp_syncookies'], (n) => {
    if (n === 'ip_forward') return file(() => enc.encode('0\n'));
    if (n === 'ip_local_port_range') return file(() => enc.encode('32768\t60999\n'));
    if (n === 'tcp_syncookies') return file(() => enc.encode('1\n'));
    return null;
  });

  const sysNet = dir(() => ['ipv4', 'dev'], (n) => {
    if (n === 'ipv4') return sysNetIpv4;
    if (n === 'dev') return file(() => enc.encode('Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n'));
    return null;
  });

  const sysFs = dir(() => ['file-nr', 'inode-nr', 'pipe-max-size'], (n) => {
    if (n === 'file-nr') return file(() => enc.encode(`${[...kernel.procs.values()].reduce((a, p) => a + p.fds.size, 0)}\t0\t9223372036854775807\n`));
    if (n === 'inode-nr') return file(() => enc.encode(`${kernel.vfs.root.ino}\t0\n`));
    if (n === 'pipe-max-size') return file(() => enc.encode('1048576\n'));
    return null;
  });

  const stats = () => {
    const s = kernel.stats;
    const ncpu = Math.max(1, globalThis.navigator?.hardwareConcurrency || 4);
    let out = '';
    for (let i = 0; i < ncpu; i++) {
      const ticks = Math.floor(kernel.uptime * 100) + i;
      out += `cpu${i} ${ticks} 0 ${ticks} ${ticks * 10} 0 0 0 0 0 0\n`;
    }
    out += `cpu ${Math.floor(kernel.uptime * 100 * ncpu)} 0 ${Math.floor(kernel.uptime * 100 * ncpu)} ${Math.floor(kernel.uptime * 1000)} 0 0 0 0 0 0\n`;
    out += `intr ${s.irqs} 0 0 0\nctxt ${s.contextSwitches}\nbtime ${Math.floor(kernel.bootTime / 1000)}\n`;
    out += `processes ${s.procsCreated}\nprocs_running ${[...kernel.procs.values()].filter((p) => p.state === 'R').length}\n`;
    out += `procs_blocked ${[...kernel.procs.values()].filter((p) => p.state === 'S').length}\nsoftirq 0 0 0\n`;
    return out;
  };

  const sysvipcDir = (kind) => {
    const header = {
      msg: '       key      msqid perms      cbytes       qnum lspid lrpid   uid   gid  cuid  cgid      stime      rtime      ctime\n',
      sem: '       key      semid perms      nsems   uid   gid  cuid  cgid      otime      ctime\n',
      shm: '       key      shmid perms                  size  cpid  lpid nattch   uid   gid  cuid  cgid      atime      dtime      ctime\n',
    };
    return file(() => {
      const l = kernel.ipc.list();
      let out = header[kind] || '';
      if (kind === 'msg') for (const q of l.messages) out += `${q.key} ${q.msqid} ${q.mode.toString(8)} ${q.qbytes} ${q.qnum} ${q.lspid} ${q.lrpid} ${q.uid} ${q.gid} ${q.uid} ${q.gid} 0 0 0\n`;
      if (kind === 'sem') for (const s of l.semaphores) out += `${s.key} ${s.semid} ${s.mode.toString(8)} ${s.nsems} ${s.uid} ${s.gid} ${s.uid} ${s.gid} 0 0\n`;
      if (kind === 'shm') for (const m of l.shared) out += `${m.key} ${m.shmid} ${m.mode.toString(8)} ${m.size} 0 0 ${m.nattch} ${m.uid} ${m.gid} ${m.uid} ${m.gid} 0 0 0\n`;
      return enc.encode(out);
    });
  };

  root.dynamic = {
    names() {
      const pids = [...kernel.procs.keys()].sort((a, b) => a - b).map(String);
      return ['self', 'thread-self', 'stat', 'vmstat', 'meminfo', 'cpuinfo', 'uptime', 'version',
        'mounts', 'loadavg', 'filesystems', 'devices', 'sys', 'net', 'tty', 'consoles',
        'interrupts', 'diskstats', 'partitions', 'swaps', 'modules', 'kmsg', 'sysvipc', 'crypto', ...pids];
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
          return enc.encode(`MemTotal:       ${kb(m.total)} kB\nMemFree:        ${kb(m.free)} kB\nMemAvailable:   ${kb(m.free)} kB\nBuffers:        ${kb(m.buffers)} kB\nCached:         0 kB\nSwapTotal:      0 kB\nSwapFree:       0 kB\nDirty:          0 kB\nWriteback:      0 kB\n`);
        });
      }
      if (name === 'stat') return file(() => enc.encode(stats()));
      if (name === 'vmstat') {
        return file(() => enc.encode(`nr_free_pages ${Math.round(kernel.memoryInfo().free / 4096)}\nnr_active_file 0\nnr_inactive_file 0\npgfault ${kernel.stats.pageFaults}\npgmajfault 0\npgpgin 0\npgpgout 0\npswpin 0\npswpout 0\n`));
      }
      if (name === 'uptime') return file(() => enc.encode(`${kernel.uptime.toFixed(2)} ${(kernel.uptime * 0.9).toFixed(2)}\n`));
      if (name === 'loadavg') return file(() => enc.encode(`${kernel.loadavg().map((n) => n.toFixed(2)).join(' ')} ${[...kernel.procs.values()].filter((p) => p.state === 'R').length}/${kernel.procs.size} ${kernel.nextPid}\n`));
      if (name === 'version') return file(() => enc.encode('Linux version 6.6.0-webos (js@webos) #1 SMP WebOS-JS\n'));
      if (name === 'mounts') return file(() => enc.encode(mountText(kernel)));
      if (name === 'filesystems') return file(() => enc.encode('nodev\tsysfs\nnodev\tproc\nnodev\ttmpfs\nnodev\tdevtmpfs\nnodev\tdevpts\n\text2\n\text4\n\txfs\n\tbtrfs\n'));
      if (name === 'devices') return file(() => enc.encode('Character devices:\n  1 mem\n  4 /dev/tty\n  5 /dev/tty\n  5 /dev/console\n  1 /dev/null\n  1 /dev/zero\n  1 /dev/random\n  1 /dev/urandom\n'));
      if (name === 'interrupts') return file(() => enc.encode('           CPU0\n  0:          0   IO-APIC   2-edge      timer\n  1:          0   IO-APIC   1-edge      i8042\n  8:          0   IO-APIC   8-edge      rtc0\nNMI:          0   Non-maskable interrupts\nLOC:      0   Local timer interrupts\n'));
      if (name === 'diskstats') return file(() => enc.encode(' 179       0 webosroot 1024 0 8192 0 512 0 4096 0 0 0 0 0 0 0\n'));
      if (name === 'partitions') return file(() => enc.encode('major minor  #blocks  name\n\n 179        0    8388608 webosroot\n'));
      if (name === 'swaps') return file(() => enc.encode('Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n'));
      if (name === 'modules') return file(() => enc.encode(''));
      if (name === 'crypto') return file(() => enc.encode('name         : cbc(aes)\ndriver       : cbc(aes-generic)\nmodule       : webos_crypto\npriority     : 100\n'));
      if (name === 'kmsg') return file(() => enc.encode(kernel.log.kmsgText()), 0o400);
      if (name === 'tty') return new Inode('symlink', 0o777, { target: '/dev/tty' });
      if (name === 'consoles') return file(() => enc.encode('/dev/console\n'));
      if (name === 'sysvipc') return dir(() => ['msg', 'sem', 'shm'], (n) => (['msg', 'sem', 'shm'].includes(n) ? sysvipcDir(n) : null));
      if (name === 'sys') return dir(() => ['kernel', 'fs', 'net'], (n) => {
        if (n === 'kernel') return sysKernel;
        if (n === 'fs') return sysFs;
        if (n === 'net') return sysNet;
        return null;
      });
      if (name === 'net') return dir(() => ['dev', 'tcp', 'udp', 'unix'], (n) => {
        if (n === 'dev') return file(() => enc.encode('Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n'));
        if (n === 'tcp') return file(() => enc.encode('  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0\n'));
        if (n === 'udp') return file(() => enc.encode('  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n'));
        if (n === 'unix') return file(() => enc.encode('Num       RefCount Protocol Flags    Type St Inode Path\n' +
          kernel.ipc.list().unix.map((p, i) => `${(0x10000000 + i).toString(16).toUpperCase()}: 00000002 00000000 00010000 0001 01 ${100 + i} ${p}`).join('\n') + (kernel.ipc.list().unix.length ? '\n' : '')));
        return null;
      });
      return null;
    },
  };
}
