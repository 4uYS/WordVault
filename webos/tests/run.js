/* WebOS-JS test suite. Run with: npm test (node tests/run.js) */

import { createWebOS } from '../src/index.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; failures.push({ name, detail }); console.error(`FAIL  ${name}${detail ? '\n      ' + detail.replace(/\n/g, '\n      ') : ''}`); }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `expected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`);
}

function has(name, actual, needle) {
  ok(name, String(actual).includes(needle), `expected to contain: ${JSON.stringify(needle)}\nactual: ${JSON.stringify(actual)}`);
}

function notHas(name, actual, needle) {
  ok(name, !String(actual).includes(needle), `expected NOT to contain: ${JSON.stringify(needle)}\nactual: ${JSON.stringify(actual)}`);
}

const os = createWebOS({ hostname: 'webos-test' });

async function sh(cmd, opts) {
  return os.exec(cmd, opts);
}

async function expectOut(name, cmd, expected, opts) {
  const r = await sh(cmd, opts);
  eq(name, r.stdout, expected);
  return r;
}

/* ------------------------------- kernel ------------------------------- */

{
  const r = await sh('cat /etc/passwd');
  has('passwd contains root', r.stdout, 'root:x:0:0');
  has('passwd contains user', r.stdout, 'user:x:1000:1000');
  eq('passwd exit code', r.code, 0);

  const p = await sh('cat /proc/self/status');
  has('proc status Name', p.stdout, 'Name:');
  has('proc status Uid', p.stdout, 'Uid:');

  const d = await sh('ls /dev');
  has('dev null', d.stdout, 'null');
  has('dev zero', d.stdout, 'zero');

  const denied = await os.execAs('user', 'cat /root/secret 2>/dev/null');
  ok('permission check on /root', denied.code !== 0, `code=${denied.code} out=${denied.stdout}`);

  const cwd = await os.exec('pwd', { cwd: '/tmp' });
  eq('initial cwd', cwd.stdout, '/tmp\n');
}

/* -------------------------------- shell -------------------------------- */

await expectOut('echo', 'echo hello', 'hello\n');
await expectOut('assignment', 'x=5; echo $x', '5\n');
await expectOut('arithmetic', 'echo $((1+2*3))', '7\n');
await expectOut('arith compare', 'echo $((1 == 1))', '1\n');
await expectOut('default param', 'unset y; echo ${y:-def}', 'def\n');
await expectOut('parameter length', 'x=abcd; echo ${#x}', '4\n');
await expectOut('command substitution', 'echo $(echo sub)', 'sub\n');
await expectOut('pipeline', 'printf "b\\na\\n" | sort', 'a\nb\n');
await expectOut('and-or', 'true && echo yes || echo no', 'yes\n');
await expectOut('for loop', 'for i in 1 2 3; do printf "%s" $i; done; echo', '123\n');
await expectOut('while loop', 'i=0; while [ $i -lt 3 ]; do i=$((i+1)); done; echo $i', '3\n');
await expectOut('if', 'if [ 2 -gt 1 ]; then echo big; fi', 'big\n');
await expectOut('case', 'x=b; case $x in a) echo A;; b) echo B;; esac', 'B\n');
await expectOut('function', 'f() { echo "f:$1"; }; f z', 'f:z\n');
await expectOut('glob', 'cd /etc; echo pass*', 'passwd\n');
await expectOut('redirect', 'echo hi > /tmp/r.txt; cat /tmp/r.txt', 'hi\n');
await expectOut('append', 'echo a > /tmp/ap; echo b >> /tmp/ap; wc -l < /tmp/ap', '2\n');
await expectOut('heredoc', 'cat <<EOF\nline1\nline2\nEOF', 'line1\nline2\n');
await expectOut('herestring', 'cat <<< "hs"', 'hs\n');
await expectOut('pipe status', 'yes | head -n 2', 'y\ny\n');
await expectOut('subshell', '(cd /tmp; pwd); pwd', '/tmp\n/home/user\n');
await expectOut('exit status', 'false; echo $?', '1\n');

/* ------------------------------ coreutils ------------------------------ */

await expectOut('mkdir/ls', 'mkdir -p /tmp/t1/a/b && ls /tmp/t1/a', 'b\n');
await expectOut('cp/mv/rm', 'echo x > /tmp/f1; cp /tmp/f1 /tmp/f2; mv /tmp/f2 /tmp/f3; cat /tmp/f3; rm /tmp/f3', 'x\n');
await expectOut('wc', 'printf "a b\\nc d\\n" | wc -l', '2\n');
await expectOut('head', 'printf "1\\n2\\n3\\n" | head -n 2', '1\n2\n');
await expectOut('tail', 'printf "1\\n2\\n3\\n" | tail -n 1', '3\n');
await expectOut('tac', 'printf "1\\n2\\n" | tac', '2\n1\n');
await expectOut('seq', 'seq 3', '1\n2\n3\n');
await expectOut('basename', 'basename /a/b/c.txt .txt', 'c\n');
await expectOut('dirname', 'dirname /a/b/c', '/a/b\n');
await expectOut('stat mode', 'stat -c %a /tmp', '1777\n');
await expectOut('ln', 'echo z > /tmp/lz; ln -s /tmp/lz /tmp/lz.link; readlink /tmp/lz.link', '/tmp/lz\n');
await expectOut('realpath', 'realpath /tmp/../etc/passwd', '/etc/passwd\n');
await expectOut('printf', 'printf "%s-%s\\n" a b', 'a-b\n');
await expectOut('expr', 'expr 2 + 3', '5\n');
await expectOut('factor', 'factor 12', '12: 2 2 3\n');

/* -------------------------------- text --------------------------------- */

await expectOut('grep', 'printf "abc\\ndef\\n" | grep -n bc', '1:abc\n');
await expectOut('grep -v -c', 'printf "a\\nb\\na\\n" | grep -vc a', '1\n');
await expectOut('sed s', 'echo abc | sed "s/b/X/"', 'aXc\n');
await expectOut('sed delete', 'printf "1\\n2\\n3\\n" | sed 2d', '1\n3\n');
await expectOut('awk fields', 'printf "a 1\\nb 2\\n" | awk "{print \\$2, \\$1}"', '1 a\n2 b\n');
await expectOut('awk sum', 'printf "1\\n2\\n3\\n" | awk "{s+=\\$1} END {print s}"', '6\n');
await expectOut('cut', 'echo a,b,c | cut -d, -f2', 'b\n');
await expectOut('tr', 'echo abc | tr a-z A-Z', 'ABC\n');
await expectOut('sort -n', 'printf "10\\n2\\n1\\n" | sort -n', '1\n2\n10\n');
await expectOut('uniq -c', 'printf "a\\na\\nb\\n" | uniq -c', '      2 a\n      1 b\n');
await expectOut('join', 'printf "1 a\\n2 b\\n" > /tmp/j1; printf "1 x\\n2 y\\n" > /tmp/j2; join /tmp/j1 /tmp/j2', '1 a x\n2 b y\n');
await expectOut('comm', 'printf "a\\nb\\n" > /tmp/c1; printf "b\\nc\\n" > /tmp/c2; comm /tmp/c1 /tmp/c2', 'a\n\t\tb\n\tc\n');
await expectOut('find', 'find /etc -maxdepth 1 -name passwd', '/etc/passwd\n');
await expectOut('xargs', 'printf "a b c\\n" | xargs echo pre', 'pre a b c\n');
await expectOut('diff same', 'echo a > /tmp/d1; echo a > /tmp/d2; diff /tmp/d1 /tmp/d2; echo $?', '0\n');
await expectOut('nl', 'printf "a\\nb\\n" | nl', '     1\ta\n     2\tb\n');
await expectOut('paste', 'printf "a\\nb\\n" > /tmp/p1; printf "1\\n2\\n" > /tmp/p2; paste /tmp/p1 /tmp/p2', 'a\t1\nb\t2\n');
await expectOut('fold', 'printf "abcdef\\n" | fold -w 3', 'abc\ndef\n');
await expectOut('expand', 'printf "a\\tb\\n" | expand -t 4', 'a   b\n');
await expectOut('od', 'printf "A" | od -An -tx1', ' 41\n');

/* ------------------------------- archive ------------------------------- */

await expectOut('md5sum', 'printf abc | md5sum', '900150983cd24fb0d6963f7d28e17f72  -\n');
await expectOut('sha256sum', 'printf abc | sha256sum', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n');
await expectOut('base64', 'printf hello | base64', 'aGVsbG8=\n');
await expectOut('base64 -d', 'printf aGVsbG8= | base64 -d', 'hello');
await expectOut('base32', 'printf hello | base32', 'NBSWY3DP\n');
{
  const r = await sh('mkdir -p /tmp/arc/d; echo one > /tmp/arc/d/1.txt; echo two > /tmp/arc/d/2.txt; tar -cf /tmp/arc/a.tar -C /tmp/arc d; tar -tf /tmp/arc/a.tar');
  has('tar list', r.stdout, 'd/');
  has('tar list file', r.stdout, 'd/1.txt');
  const x = await sh('mkdir -p /tmp/arc/out; tar -xf /tmp/arc/a.tar -C /tmp/arc/out; cat /tmp/arc/out/d/2.txt');
  eq('tar extract', x.stdout, 'two\n');
}
{
  const r = await sh('printf "gzip me" > /tmp/g.txt; gzip -c /tmp/g.txt > /tmp/g.gz; gunzip -c /tmp/g.gz');
  eq('gzip round trip', r.stdout, 'gzip me');
}

/* -------------------------------- system ------------------------------- */

{
  const who = await sh('whoami');
  eq('whoami', who.stdout, 'user\n');
  const idu = await sh('id -u');
  eq('id -u', idu.stdout, '1000\n');
  const un = await sh('uname -s');
  eq('uname', un.stdout, 'Linux\n');
  const ps = await sh('ps');
  has('ps header', ps.stdout, 'PID');
  const host = await sh('hostname');
  eq('hostname', host.stdout, 'webos-test\n');
  const mem = await sh('free -m');
  has('free', mem.stdout.toLowerCase(), 'mem');
  const df = await sh('df -h /');
  has('df', df.stdout, '/');
  const su = await sh('su nosuchuser -c "whoami"');
  ok('su rejects unknown user', su.code !== 0 && su.stderr.includes('does not exist'), JSON.stringify(su));
  const suRoot = await sh('su -c "id -u"');
  eq('su root by uid', suRoot.stdout, '0\n');
}

/* -------------------------------- node --------------------------------- */

{
  const r = await os.exec('node -e "console.log(1+1)"');
  eq('node -e', r.stdout, '2\n');
  const v = await os.exec('node -e "console.log(process.platform)"');
  eq('node process.platform', v.stdout, 'linux\n');
  const f = await os.exec('node -e "const fs=require(\'fs\');fs.writeFileSync(\'/tmp/n.txt\',\'ok\');console.log(fs.readFileSync(\'/tmp/n.txt\',\'utf8\'))"');
  eq('node fs', f.stdout, 'ok\n');
  const p = await os.exec('node -e "console.log(require(\'path\').join(\'/a\',\'b\',\'..\',\'c\'))"');
  eq('node path', p.stdout, '/a/c\n');
  const c = await os.exec('node -e "console.log(require(\'crypto\').createHash(\'sha256\').update(\'abc\').digest(\'hex\'))"');
  eq('node crypto', c.stdout, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n');
  const b = await os.exec('node -e "const {Buffer}=require(\'buffer\');console.log(Buffer.from(\'aGk=\',\'base64\').toString())"');
  eq('node buffer', b.stdout, 'hi\n');
  const z = await os.exec('node -e "const z=require(\'zlib\');console.log(z.gunzipSync(z.gzipSync(Buffer.from(\'zip\'))).toString())"');
  eq('node zlib', z.stdout, 'zip\n');
  const ev = await os.exec('node -e "const {EventEmitter}=require(\'events\');const e=new EventEmitter();e.on(\'x\',(v)=>console.log(v));e.emit(\'x\',5)"');
  eq('node events', ev.stdout, '5\n');
  const json = await os.exec('node -e "console.log(JSON.stringify(require(\'/etc/webos.json\')))"');
  ok('node json module', json.code === 0 || json.stderr.includes('Cannot find module'), json.stderr);
  const hello = await os.exec('node /home/user/hello.js');
  eq('node script file', hello.code, 0, hello.stderr);
  ok('node hello output', hello.stdout.length > 0, hello.stdout);
}

/* ------------------------------ user command --------------------------- */

os.registerCommand('upper', {
  summary: 'uppercase',
  async run(c) { c.out((await c.readText()).toUpperCase()); return 0; },
});
await expectOut('custom command', 'printf abc | upper', 'ABC');
await expectOut('custom command in PATH', 'which upper', '/usr/bin/upper\n');

/* --------------------------- advanced kernel --------------------------- */

{
  const root = (cmd) => os.execAs('root', cmd);
  const mountList = await root('mount');
  has('mount lists root', mountList.stdout, 'on / type ext4');
  const procMounts = await root('cat /proc/mounts');
  has('proc mounts has tmpfs', procMounts.stdout, '/tmp tmpfs');
  const dfTmp = await root('df -h /tmp');
  has('df tmpfs', dfTmp.stdout, 'tmpfs');

  const mounted = await root('mkdir -p /mnt/k && mount -t tmpfs -o size=1m tmpfs /mnt/k && echo hi > /mnt/k/f && cat /mnt/k/f');
  eq('tmpfs mount write', mounted.stdout, 'hi\n');
  const dfMnt = await root('df -h /mnt/k');
  has('df mounted tmpfs', dfMnt.stdout, '/mnt/k');
  const unmounted = await root('umount /mnt/k && ls /mnt/k');
  eq('umount hides mount', unmounted.stdout, '');

  const ro = await root('mkdir -p /mnt/ro && mount -t tmpfs -o ro tmpfs /mnt/ro && echo x > /mnt/ro/f');
  ok('read-only mount rejects writes', ro.code !== 0 && /EROFS|Read-only/.test(ro.stderr), JSON.stringify(ro));
  await root('umount /mnt/ro');

  const hn = await root('sysctl -w kernel.hostname=k3 >/dev/null && hostname');
  eq('sysctl hostname', hn.stdout, 'k3\n');
  const sysHost = await root('cat /proc/sys/kernel/hostname');
  eq('proc sys hostname', sysHost.stdout, 'k3\n');

  const ctx = { uid: 0, gid: 0, cwd: '/tmp', pid: os.kernel.initProc.pid };
  const fd = await os.syscall('open', ['/tmp/sc.txt', 0o1101, 0o644], ctx);
  eq('syscall write', await os.syscall('write', [fd, new TextEncoder().encode('sc')], ctx), 2);
  await os.syscall('close', [fd], ctx);
  const fd2 = await os.syscall('open', ['/tmp/sc.txt', 0, 0], ctx);
  eq('syscall read', new TextDecoder().decode(await os.syscall('read', [fd2, 10], ctx)), 'sc');
  await os.syscall('close', [fd2], ctx);

  const qid = await os.syscall('msgget', [555, 0o1000 | 0o666], ctx);
  await os.syscall('msgsnd', [qid, 2, new TextEncoder().encode('mq')], ctx);
  const msg = await os.syscall('msgrcv', [qid, 10, 0, 0], ctx);
  eq('sysv message queue', new TextDecoder().decode(msg.data), 'mq');
  const sem = await os.syscall('semget', [556, 1, 0o1000 | 0o666], ctx);
  await os.syscall('semop', [sem, [{ sem_num: 0, sem_op: 5 }]], ctx);
  eq('sysv semaphore', await os.syscall('semctl', [sem, 0, 11], ctx), 5);
  const shm = await os.syscall('shmget', [557, 16, 0o1000 | 0o666], ctx);
  const at = await os.syscall('shmat', [shm], ctx);
  at.data.set(new TextEncoder().encode('sm'));
  eq('sysv shared memory', new TextDecoder().decode(at.data.slice(0, 2)), 'sm');
  const ipcs = await root('ipcs');
  has('ipcs shows queues', ipcs.stdout, 'Message Queues');

  const [s1, s2] = await os.syscall('socketpair', [], ctx);
  await os.syscall('write', [s1, new TextEncoder().encode('sock')], ctx);
  eq('socketpair', new TextDecoder().decode(await os.syscall('read', [s2, 10], ctx)), 'sock');

  const child = os.kernel.forkProcess(os.kernel.getProcess(ctx.pid), { name: 't-child' });
  setTimeout(() => child.setExit(3), 5);
  const w = await os.syscall('waitpid', [child.pid, 0], { pid: ctx.pid });
  eq('waitpid exit code', w.code, 3);
  ok('waitpid status encoding', w.status === (3 << 8), `status=${w.status}`);

  const kmsg = await root('cat /dev/kmsg');
  has('dev kmsg', kmsg.stdout, 'Linux version');

  await root('echo snap > /etc/snap.txt');
  const snap = os.snapshot();
  ok('snapshot is serializable', typeof JSON.stringify(snap) === 'string' && snap.format === 'webos-snapshot');
  const os2 = createWebOS({ snapshot: snap });
  const restored = await os2.execAs('root', 'cat /etc/snap.txt');
  eq('snapshot restore', restored.stdout, 'snap\n');
}

/* -------------------------------- summary ------------------------------- */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.error('\nFailures:');
  for (const f of failures) console.error(` - ${f.name}`);
  process.exit(1);
}
