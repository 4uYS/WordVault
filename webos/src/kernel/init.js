/* Builds the default root filesystem image. */

import { Inode, dev } from './vfs.js';
import { USERS, GROUPS } from './process.js';

const enc = new TextEncoder();
const ROOT = { uid: 0, gid: 0, cwd: '/' };

export function buildRootfs(kernel) {
  const vfs = kernel.vfs;
  const mkdir = (p, mode = 0o755) => {
    const r = vfs.resolve(p, ROOT, { allowMissingFinal: true });
    if (!r.node) vfs.mkdir(p, ROOT, mode);
    vfs.chmod(p, mode, ROOT);
  };
  const file = (p, text, mode = 0o644, uid = 0, gid = 0) => {
    vfs.writeFile(p, text, { uid, gid, cwd: '/' }, { mode });
    vfs.chmod(p, mode, ROOT);
    vfs.chown(p, uid, gid, ROOT);
    const now = Date.now();
    const node = vfs.resolve(p, ROOT).node;
    node.mtime = node.atime = node.ctime = now;
  };

  for (const d of ['/bin', '/sbin', '/etc', '/home', '/home/user', '/root', '/tmp', '/var',
    '/var/log', '/var/tmp', '/var/lib', '/usr', '/usr/bin', '/usr/sbin', '/usr/lib',
    '/usr/local', '/usr/local/bin', '/usr/local/sbin', '/usr/share', '/opt', '/srv',
    '/mnt', '/media', '/dev', '/proc', '/sys', '/run', '/lib', '/boot']) mkdir(d, 0o755);
  mkdir('/root', 0o700);
  mkdir('/tmp', 0o1777);
  mkdir('/var/tmp', 0o1777);
  mkdir('/home/user', 0o755);
  vfs.chown('/home/user', 1000, 1000, ROOT);

  // device nodes
  const addDev = (name, devName, mode = 0o666) => {
    const node = dev.char(devName, { perm: mode });
    const parent = vfs.resolve('/dev', ROOT).node;
    parent.children.set(name, node);
    node.parent = parent;
  };
  for (const [n, d] of [['null', 'null'], ['zero', 'zero'], ['full', 'full'], ['random', 'random'],
    ['urandom', 'urandom'], ['tty', 'tty'], ['console', 'console'], ['ptmx', 'ptmx'],
    ['stdin', 'stdin'], ['stdout', 'stdout'], ['stderr', 'stderr']]) addDev(n, d);
  for (const [n, t] of [['fd', '/proc/self/fd'], ['stdin', '/proc/self/fd/0'], ['stdout', '/proc/self/fd/1'], ['stderr', '/proc/self/fd/2']]) {
    const parent = vfs.resolve('/dev', ROOT).node;
    if (parent.children.has(n)) continue;
    const link = new Inode('symlink', 0o777, { target: t });
    parent.children.set(n, link); link.parent = parent;
  }
  // real kernel log devices
  {
    const parent = vfs.resolve('/dev', ROOT).node;
    const kmsg = new Inode('file', 0o400, { dynamic: { read: () => enc.encode(kernel.log.kmsgText()) } });
    parent.children.set('kmsg', kmsg); kmsg.parent = parent;
    const log = new Inode('symlink', 0o777, { target: '/var/log/syslog' });
    parent.children.set('log', log); log.parent = parent;
  }
  // /etc/mtab is a symlink to /proc/mounts, like modern util-linux
  {
    const etc = vfs.resolve('/etc', ROOT).node;
    const link = new Inode('symlink', 0o777, { target: '/proc/mounts' });
    etc.children.set('mtab', link); link.parent = etc;
  }

  // /etc
  const passwd = USERS.map((u) => `${u.name}:x:${u.uid}:${u.gid}:${u.gecos}:${u.home}:${u.shell}`).join('\n') + '\n';
  file('/etc/passwd', passwd);
  file('/etc/shadow', USERS.map((u) => `${u.name}:!*:19000:0:99999:7:::`).join('\n') + '\n', 0o640);
  file('/etc/group', GROUPS.map((g) => `${g.name}:x:${g.gid}:${g.members.join(',')}`).join('\n') + '\n');
  file('/etc/hostname', kernel.hostname + '\n');
  file('/etc/hosts', `127.0.0.1\tlocalhost\n127.0.1.1\t${kernel.hostname}\n::1\tlocalhost ip6-localhost ip6-loopback\n`);
  file('/etc/resolv.conf', 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n');
  file('/etc/nsswitch.conf', 'passwd: files\ngroup: files\nhosts: files dns\n');
  file('/etc/os-release', `NAME="WebOS"\nVERSION="1.0 (JavaScript)"\nID=webos\nID_LIKE=linux\nPRETTY_NAME="WebOS 1.0 (JavaScript)"\nANSI_COLOR="0;38;2;16;185;129"\nHOME_URL="https://example.invalid/webos"\nVERSION_ID="1.0"\n`);
  file('/etc/issue', 'WebOS 1.0 \\n \\l\n\n');
  file('/etc/motd', 'Welcome to WebOS, a Linux-like operating system running inside your JavaScript engine.\n');
  file('/etc/shells', '/bin/sh\n/bin/bash\n/bin/false\n');
  file('/etc/fstab', '# <file system> <mount point> <type> <options> <dump> <pass>\nproc /proc proc defaults 0 0\ntmpfs /tmp tmpfs defaults 0 0\n');
  file('/etc/profile', `export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/home/user
export USER=user
export SHELL=/bin/sh
export LANG=C.UTF-8
umask 022
`);
  file('/etc/bash.bashrc', 'PS1=\'\\u@\\h:\\w\\$ \'\n');
  file('/etc/environment', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nLANG=C.UTF-8\n');

  // user files
  file('/home/user/.profile', 'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n', 0o644, 1000, 1000);
  file('/home/user/.bashrc', `export PS1='\\u@\\h:\\w\\$ '
export PATH="$HOME/.local/bin:$PATH"
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
`, 0o644, 1000, 1000);
  file('/home/user/hello.js', `#!/usr/bin/env node
const os = require('os');
console.log('Hello from Node.js ' + process.version + ' on ' + os.platform());
console.log('cwd =', process.cwd());
const fs = require('fs');
fs.writeFileSync('/tmp/hello.txt', 'written by node\\n');
console.log('file =', fs.readFileSync('/tmp/hello.txt', 'utf8').trim());
`, 0o644, 1000, 1000);
  file('/home/user/notes.txt', 'WebOS demo filesystem.\nTry: ls -la, echo hi | wc -c, node hello.js\n', 0o644, 1000, 1000);
  file('/home/user/.bash_logout', '# ~/.bash_logout\n', 0o644, 1000, 1000);

  file('/var/log/lastlog', '');
  file('/var/log/wtmp', '');
  file('/var/log/btmp', '');
  file('/var/log/syslog', '');

  vfs.chmod('/tmp', 0o1777, ROOT);
  vfs.chmod('/var/tmp', 0o1777, ROOT);
}
