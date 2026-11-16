# WebOS-JS

一个**无界面**的 WebOS：纯 JavaScript 实现的虚拟 Linux 内核 + POSIX Shell + 用户态命令集 + Node.js 兼容运行时。它不是网页应用，没有 DOM、没有终端组件、没有主题或布局；对外暴露的只是一组 API，用来在浏览器或 Node 中创建“一台机器”、执行命令、读写虚拟文件系统、运行 Node 脚本。

- 运行环境：现代浏览器（ES2022、ESM、`TextEncoder`、`CompressionStream`）或 Node.js ≥ 20。
- 零依赖、零 WASM（仅依赖平台自带的 Web API）。
- 所有状态都在内存里，可随时 `createWebOS()` 得到一台全新的机器。

```js
import { createWebOS } from './src/index.js';

const os = createWebOS();

const r = await os.exec('echo hello | tr a-z A-Z');
console.log(r.stdout);          // "HELLO\n"
console.log(r.code);            // 0

await os.exec('mkdir -p /home/user/app && echo "console.log(1+1)" > /home/user/app/a.js');
const n = await os.exec('node /home/user/app/a.js');
console.log(n.stdout);          // "2\n"
```

## 快速上手

```js
const os = createWebOS({ hostname: 'sandbox', user: 'user' });

// 1. 执行 shell 命令（支持管道、重定向、变量、控制流、函数、alias…）
const { code, stdout, stderr } = await os.exec('for f in /etc/*; do echo "$f"; done');

// 2. 以 root 身份执行
await os.execAs('root', 'cat /etc/shadow');

// 3. 启动一个会话，实时读取输出（Channel 是异步可迭代的）
const { pid, stdout, done } = os.spawn('yes | head -n 3');
for await (const chunk of stdout) process.stdout.write(chunk);
await done;

// 4. 直接操作 VFS
os.fs.mkdirp('/data');
os.fs.writeFile('/data/x.txt', 'hello');
console.log(os.fs.readFile('/data/x.txt'));   // "hello"
console.log(os.fs.readdir('/data'));          // ["x.txt"]

// 5. 注册自定义命令（自动出现在 /bin 与 PATH 中）
os.registerCommand('hello', {
  summary: 'say hello',
  async run(c) { c.out(`hello ${c.args[0] || 'world'}\n`); return 0; },
});

// 6. 直接跑 Node 源码
const out = await os.runNodeFile('/home/user/hello.js', ['arg1']);

// 7. 内核级 API：挂载、系统调用、IPC、快照
os.mount('tmpfs', '/mnt', 'tmpfs', 'size=8m,mode=1777');
await os.execAs('root', 'echo hi > /mnt/x');
const qid = await os.syscall('msgget', [0x1234, 0o1000 | 0o666]);
await os.syscall('msgsnd', [qid, 1, new TextEncoder().encode('hello')]);
const msg = await os.syscall('msgrcv', [qid, 64, 0, 0]);
console.log(new TextDecoder().decode(msg.data));  // "hello"
const snap = os.snapshot();                        // JSON 可序列化
const machine2 = createWebOS({ snapshot: snap });  // 恢复同一台机器
```

## 单文件产物

`npm run build` 会把 `src/` 下全部 45 个模块内联为一个自包含的 ESM 文件：

```bash
npm run build
# bundled 45 modules -> dist/webos.js (~0.9 MB)
```

浏览器中直接使用（无需打包器、无需服务器端依赖）：

```html
<script type="module">
  import { createWebOS } from './dist/webos.js';
  const os = createWebOS();
  const { stdout } = await os.exec('uname -a');
  console.log(stdout);
</script>
```

Node 中也可以直接 `import './dist/webos.js'`。该文件由 `tools/bundle.mjs` 生成，修改 `src/` 后需重新执行 `npm run build`；测试基线对源码与产物分别运行，均为 118 项通过。

`os` 对象上的主要成员：

| 成员 | 说明 |
| --- | --- |
| `kernel` | 虚拟内核：VFS、进程表、用户/组、`/proc`、命令表 |
| `fs` | 面向宿主的同步便捷文件 API（root 权限） |
| `exec(cmd, opts)` | 执行命令行，返回 `{code, stdout, stderr, pid}` |
| `execAs(user, cmd)` | 指定用户执行 |
| `spawn(cmd)` | 不等待，返回 `{pid, stdout, stderr, done}` |
| `createShell(opts)` | 创建可复用的 Shell 实例 |
| `runNodeFile(path, args)` | 通过 JS 运行时执行 Node 脚本 |
| `registerCommand(name, def)` | 注册命令 |
| `syscall(name, args, ctx)` | 以 Linux 风格调用内核（`open/read/write/waitpid/mount/msgget…`） |
| `mount/umount` | 挂载/卸载虚拟文件系统（`tmpfs`、`proc`、`sysfs`、`devtmpfs`、`devpts`、`bind`） |
| `ipc` | System V 消息队列/信号量/共享内存，AF_UNIX 套接字 |
| `log` | 内核环形日志（`dmesg`、`/dev/kmsg`、`/proc/kmsg`） |
| `snapshot()/restore(state)` | 导出/恢复整机持久状态（JSON） |
| `stats` | 系统调用、fork、上下文切换、信号等计数器 |
| `commands/users/groups/info` | 只读视图 |

## 架构

```
src/
├── kernel/
│   ├── vfs.js       Inode 文件系统：权限、符号链接、硬链接、fd、设备、动态文件、挂载表
│   ├── kernel.js    进程表、命令注册、用户/组、内存信息、统计、快照入口
│   ├── process.js   进程对象、能力位、rlimit、信号、用户与组数据库
│   ├── syscalls.js  Linux 风格系统调用层（fd、IPC、waitpid、mount…）
│   ├── ipc.js       System V IPC 与 AF_UNIX 套接字
│   ├── snapshot.js  整机快照的序列化/恢复
│   ├── log.js       内核环形缓冲区与审计日志
│   ├── procfs.js    动态 /proc（stat、meminfo、self、<pid>/…）
│   ├── init.js      根文件系统：/etc、/dev、/home、/tmp、/var …
│   └── io.js        Source/Sink/Channel 字节流（管道关闭传播）
├── shell/
│   ├── parser.js    POSIX/bash 子集：管道、重定向、here-doc、函数、case…
│   ├── expand.js    参数/算术/命令替换、glob、花括号、IFS 拆分
│   ├── shell.js     执行器：管道并发、重定向、作业、子 shell、退出码
│   ├── builtins.js  内建命令（cd、export、read、test、jobs、trap…）
│   └── test-expr.js test/[ 与 [[ ]] 表达式求值
├── commands/
│   ├── coreutils.js 文件/目录/文本基础工具
│   ├── text.js      grep、sed、awk、sort、uniq、cut、find、xargs、diff…
│   ├── system.js    ps、top、uname、id、用户管理、systemctl 模拟…
│   ├── archive.js   tar、zip/unzip、gzip、base64、各类校验和
│   ├── misc.js      sh/bash、file/tree、网络工具、编码转换、make…
│   └── index.js     统一注册
├── node/
│   ├── runtime.js   CommonJS 加载器、ESM 转译、全局注入、node 命令
│   ├── crypto-hash.js / aes.js / zlib.js   纯 JS 哈希、AES、DEFLATE
│   └── modules/     fs、path、os、events、stream、util、crypto、child_process…
└── index.js         createWebOS() 公共 API
```

内核不是“命令别名集合”：所有命令都通过同一套 VFS、权限检查、进程上下文与字节流运行；管道两端是真实的 `Channel`，`yes | head` 会正确传播关闭；`/proc` 是动态生成的；`/dev/zero`、`/dev/random` 等是字符设备实现。

## 内核能力

- **挂载表**：`/`、`/proc`、`/sys`、`/dev`、`/dev/pts`、`/dev/shm`、`/run`、`/tmp` 在启动时建立挂载；支持 `tmpfs`（含 `size/mode`）、`proc`、`sysfs`、`devtmpfs`、`devpts`、`bind`，以及只读挂载。路径解析会透明穿过挂载点，`df`、`/proc/mounts`、`/proc/<pid>/mountinfo`、`mount`/`umount` 全部读取同一张挂载表。
- **系统调用层**：`os.syscall('open', [path, flags, mode], ctx)` 等 50+ 个调用，覆盖文件 fd、`dup/dup2/pipe`、`fork/waitpid/kill`、`setuid/setgid`、`getrlimit/setrlimit`、`getrusage`、`uname/sysinfo/clock_gettime`、`mount/statfs`、System V IPC 与 `socketpair`。错误统一为带 `errno` 的 `ErrnoError`。
- **进程模型**：父子关系、进程组/会话、`forkProcess()` 克隆（共享 fd 表、rlimit、环境副本）、僵尸与 `waitpid` 状态编码、孤儿进程重新挂到 init、`SIGSTOP/SIGCONT` 状态、信号屏蔽字（被屏蔽的信号进入待处理队列）。
- **凭据与限制**：`CAP_*` 能力位（root 默认全量，非 root 为空）、`RLIMIT_NOFILE/NPROC/FSIZE/…` 默认值、每个进程独立的 `umask`；`chown`、`mount`、`kill`、`setuid` 会检查能力位。
- **IPC**：System V 消息队列、信号量集合、共享内存段（真正的共享 `Uint8Array`），以及 `socketpair()`、命名 AF_UNIX 监听/连接；通过 `/proc/sysvipc/*`、`ipcs`、`ipcrm` 可观察和清理。
- **可观测性**：`dmesg`、`/dev/kmsg`、`/proc/kmsg` 来自内核环形缓冲；`/proc/stat`、`/proc/loadavg`、`/proc/vmstat`、`/proc/interrupts`、`/proc/<pid>/limits|fd|statm|cgroup` 由实时状态生成；`os.stats` 暴露系统调用/fork/上下文切换计数。
- **快照**：`os.snapshot()` 返回可 JSON 序列化的整机状态（静态 VFS、用户/组、挂载、tmpfs 内容、内核日志）；`createWebOS({ snapshot })` 或 `os.restore(state)` 可恢复。进程、打开的文件描述符、IPC 与 socket 不在快照内。

## Shell 能力

- 词法/语法：单双引号、转义、`$'...'`、注释、`;`、`&`、`&&`、`||`、`|`、`|&`、`!`、子 shell、`{ }`、`if/elif/else`、`for`、`while`、`until`、`case`、函数定义、`time`。
- 展开：`$VAR`、`${VAR:-x}`、`${#x}`、`${x%pat}`、`${x/a/b}`、`${!ref}`、`$(...)`、`$((...))`、位置参数 `$@ $* $# $? $$ $!`、算术（赋值、`++`、位运算、三元、短路）、tilde、brace、glob、IFS 拆分。
- 重定向：`> >> < <> >| &> &>> n>&m n<&m << <<- <<<`，here-doc 展开。
- 内建命令：`cd pwd echo printf read mapfile export unset set shopt alias unalias source eval exec test [ [[ let umask jobs wait kill fg bg disown trap type command builtin local declare readonly getopts pushd popd dirs hash help times ulimit history suspend return break continue shift exit` 等。
- 交互式能力（PS1、行编辑、Tab 补全、作业控制）不属于 API 的一部分，因为没有 TTY。

## Node.js 兼容运行时

`node`/`nodejs` 命令、`#!/usr/bin/env node` 脚本、`-e/-p/--version`、CommonJS 与部分 ESM 均可运行。已实现的核心模块包括：

`assert`、`buffer`、`child_process`、`console`、`crypto`、`dgram`（失败明确）、`dns`（受限）、`events`、`fs`（同步/回调/Promise 三种风格）、`http/https`（仅客户端，基于 `fetch`）、`module`、`net`（失败明确）、`os`、`path`、`perf_hooks`、`process`、`punycode`、`querystring`、`readline`、`stream`、`string_decoder`、`timers`、`tls`（失败明确）、`tty`、`url`、`util`、`vm`、`worker_threads`（同线程消息模拟）、`zlib`（纯 JS DEFLATE）。

运行时自带 `Buffer`、定时器、`console`、`URL`、`TextEncoder/Decoder`、`structuredClone`、`fetch` 等全局对象，并维护 `process.pid/cwd/argv/env/uid` 等状态。

## 关于“支持所有 Linux 命令”

**这一点在纯前端 / 纯 JS 中不可能 100% 做到，本项目也不声称做到了。** Linux 的“命令”绝大多数是编译后的原生程序（GNU coreutils、util-linux、iproute2、systemd、bash 本身……），它们通过系统调用直接与内核交互。浏览器提供的沙箱没有 `fork/execve`、`ptrace`、`mount`、`ioctl`、原始套接字、netlink、cgroup、namespace 等能力；因此：

- 本项目的做法是：**在内核层实现一套 Linux 风格的语义（VFS、进程、权限、管道、信号、`/proc`），再用 JS 重新实现常用命令的行为**。覆盖范围见下方矩阵。
- 对确实无法实现的功能，命令仍然存在，但会返回**明确、具体**的错误信息与退出码，而不是假装成功。例如 `gcc`、`gdb`、`strace`、`iptables`、`ssh`、`apt install`、`chroot`。
- 你可以通过 `registerCommand` 增加命令，或接一个 WASM/远程后端来执行真实二进制（见“扩展”）。

### 命令覆盖矩阵（按类别）

| 类别 | 已实现（行为级模拟） |
| --- | --- |
| 文件/目录 | `ls cat cp mv rm mkdir rmdir touch chmod chown chgrp ln unlink link readlink realpath basename dirname stat du df truncate mktemp mkfifo mknod install sync` |
| 查看/文本 | `head tail nl wc tac rev od hexdump xxd pr split csplit tee expand unexpand fold fmt column strings` |
| 文本处理 | `grep egrep fgrep sed awk sort uniq cut paste join comm tr diff cmp patch find xargs look` |
| 计算/日期 | `expr factor numfmt seq shuf date cal cksum sum bc dc` |
| Shell/解释器 | `sh bash dash zsh`（均为内置 Shell）、`node nodejs` |
| 进程/系统 | `ps pstree top free uptime uname arch nproc hostname whoami id groups users who w last logname tty ps`、`sleep timeout nohup nice renice killall pkill pgrep pidof`、`dmesg journalctl systemctl service init reboot shutdown runlevel` |
| 用户管理 | `useradd userdel usermod groupadd groupdel groupmod passwd chsh chfn su sudo getent` |
| 存储/设备 | `mount umount df fdisk blkid lsblk lscpu lsusb lspci sysctl swapon swapoff lsmod modprobe ipcs ipcrm`（挂载为虚拟挂载表；块设备为合成信息） |
| 归档/编码 | `tar zip unzip gzip gunzip zcat compress uncompress cpio ar base64 base32 basenc uuencode uudecode` |
| 校验和 | `md5sum sha1sum sha224sum sha256sum sha384sum sha512sum b2sum cksum sum` |
| 网络 | `curl wget ping ip ifconfig route arp netstat ss dig nslookup host lsof fuser`（HTTP 走 `fetch`，其余明确受限） |
| 编码/终端 | `iconv locale localedef dos2unix unix2dos stty tput reset clear logger` |
| 文档/帮助 | `man info help file tree less more` |
| 构建 | `make`（简单 Makefile 解释器） |
| 调试/开发 | `cc g cc1 as ld ldd nm objdump readelf ldconfig`（明确报错）；`make` 可运行简单 Makefile |
| 其他已注册 | `sync fsync install usleep lastb hwinfo systemd-analyze update-rc.d depmod insmod rmmod bzip2 bunzip2 xz unxz lz4 zstd compress uncompress aptitude zypper`（编解码器或内核能力缺失时明确报错） |
| 明确不可用 | `gcc clang python python3 perl ruby php java lua gdb strace ltrace valgrind perf wasmtime ssh scp sftp rsync ftp telnet nc chroot unshare nsenter iptables traceroute apt apt-get yum dnf pacman apk snap dpkg` |

一共注册了 **292 个命令名**。上表列出的是有实际行为的命令；“明确不可用”的命令依然存在，执行时返回 `127` 与具体原因，便于脚本探测环境能力。

## 详细局限（重要）

### 1. 内核与进程模型

- **没有真实的隔离**：没有用户态/内核态切换、seccomp、cgroup、namespace、LSM。所谓 “root” 只是 `uid=0` 的权限位判断，`sudo` 不会提升真实权限。能力位（`CAP_*`）与 rlimit 已在内核对象中实现，但只约束本虚拟内核的行为，不是宿主安全边界。
- **`fork()` 是进程级模拟**：`kernel.forkProcess()` 复制凭据、fd 表、rlimit 与环境快照，`waitpid()` 支持状态编码与僵尸回收；但不会复制 JS 调用栈/堆内存，也没有写时复制、`vfork`、真正的 `clone`。`exec` 只是替换执行上下文。
- **单线程、协作式**：JavaScript 是单线程的，所有“并发”都是事件循环上的异步交错。没有真正的并行，也没有抢占式调度。一个死循环会阻塞整个机器；`SIGKILL` 无法中断纯 JS 同步循环，只能中止协作式异步任务。
- **信号是模拟的**：`SIGTERM/SIGINT/SIGKILL/SIGHUP/SIGSTOP/SIGCONT` 有名字与传递路径，支持停止/继续与简单的信号屏蔽队列；但行为最终取决于命令是否检查 `AbortSignal`，没有完整的 `sigaction`、信号栈与 `SIGCHLD` 自动回收细节。
- **没有 TTY**：不存在真实的 `/dev/tty`、伪终端、`ioctl(TIOCGWINSZ)`、行规程（canonical mode、^C、^Z）、作业控制终端前台组。因此交互式程序、`vim`、`less` 的真实翻页、密码输入都不存在。`ioctl` 对 tty fd 只返回一个固定的 24×80 窗口。
- **没有 ptrace / 调试 / 性能计数器**：`gdb`、`strace`、`perf` 无法实现。
- **时间**：只有宿主 `Date.now()`；`clock_gettime`/`nanosleep` 是 JS 实现，没有 `adjtimex`、单调时钟精度保证、定时器分辨率语义。

### 2. 文件系统

- 纯内存：**刷新页面即丢失**。内置 `os.snapshot()` 可导出 JSON 快照并恢复，但没有自动持久化；可自行写入 IndexedDB/OPFS。
- 没有块设备、页缓存、日志、配额、inode 耗尽、稀疏文件、`fallocate` 的真实预留、`O_DIRECT`、`mmap`、`sendfile`、`splice`。
- 挂载表是虚拟的：`mount tmpfs` 会创建新的内存子树，`bind` 会深拷贝（写时隔离，而不是共享 inode），`/proc`/`sysfs` 仍由 JS 动态生成；不能挂载宿主磁盘或镜像。
- 不支持扩展属性（xattr）、POSIX ACL、SELinux/AppArmor 标签、文件能力（file capabilities）、`chattr`、磁盘配额。
- 权限模型简化：检查 owner/group/other 的 rwx 位与 `umask`，并支持 sticky 删除语义；没有 setuid/setgid 的执行语义、`fsuid`、完整的内核 supplementary group 规则。
- 时间戳统一按 UTC 展示；没有本地时区数据库（`/usr/share/zoneinfo`）、DST 规则。
- `/proc`、`/sys` 是合成的视图，字段有限；`/sys` 只提供少量约定文件。
- 文件大小受 JS 堆内存限制；大文件与高吞吐 I/O 会非常慢。
- 硬链接计数与删除语义是近似实现；没有 `renameat2`、`openat2`、`O_TMPFILE` 等现代接口。

### 3. 设备与硬件

- 没有真实设备驱动：没有磁盘、USB、PCI、GPU、串口、GPIO、声卡、摄像头、网卡。
- `/dev/null`、`/dev/zero`、`/dev/full`、`/dev/random`、`/dev/urandom` 是字符设备模拟；`/dev/tty` 等不存在。
- 没有 DMA、中断、`ioctl`、`mmap` 设备映射。
- `lsblk/lspci/lsusb/dmidecode` 只能输出合成信息或明确报错。

### 4. 网络

- 浏览器不允许原始 TCP/UDP、ICMP、监听端口。**没有 `socket()`、`bind()`、`listen()`、`accept()`、`connect()`**，因此 `http.createServer`、`net.Server`、SSH、数据库客户端、任意 TCP 客户端都不可用。
- HTTP 客户端命令（`curl`、`wget`）与 `http/https` 模块基于 `fetch`，受同源策略与 CORS 限制；不能自定义底层 socket、TLS 证书、代理链、HTTP/2 帧、WebSocket 服务端。
- 没有 DNS 解析器（`dig/nslookup/host` 对非 localhost 明确失败），没有 `/etc/resolv.conf` 的真实作用。
- `ping` 仅对 localhost 做模拟统计；其余地址报告网络不可达。
- `ip/ifconfig/route` 只展示 `lo`；不能修改接口、路由、ARP、防火墙。

### 5. 安全

- 不存在真实的安全边界：所有代码都在同一 JS 上下文运行，可以访问宿主 `globalThis`、`fetch`、存储等。**不要把本系统当作沙箱来运行不受信任的代码**。
- 没有 ASLR、NX、栈保护、seccomp 过滤、审计、SELinux。
- `sudo/su` 是权限位与身份切换的模拟，不构成安全控制。

### 6. 命令层面的具体缺口

- **原生二进制**：不能执行 ELF、PE、Mach-O。没有动态链接器、`ld.so`、共享库、`ldd`。
- **编译器/解释器**：`gcc/clang/python/perl/ruby/php/java/lua` 等均不可用（会给出明确错误）。仅 JavaScript 可执行。
- **交互式 TUI**：`vi/vim/nano/emacs/top`（真实的）、`less` 的翻页、`dialog`、`whiptail` 需要 TTY 与终端控制序列，无法实现；本项目中的 `top` 是批量快照，`less` 直接透传。
- **包管理器**：`apt/dpkg/yum/dnf/pacman/apk` 没有仓库、没有网络、没有维护者脚本；`npm install` 也不能访问 registry（可运行本地已有依赖与 `npm run` 脚本）。
- **systemd**：`systemctl` 是对内存中服务表的模拟，不管理真实进程组、cgroup、依赖图、socket 激活、日志总线。
- **内核工具**：`mount/umount` 只操作虚拟挂载表，不会触及宿主；`swapon/iptables/modprobe/chroot/unshare/nsenter` 等对宿主无效，会返回明确错误或只读信息。
- **文本工具的边界**：`sed/awk/grep` 覆盖常用语法，但不是 GNU 的逐字节兼容实现；`awk` 不支持 `getline < file` 的全部重定向形式、`printf` 的极端格式、locale 排序；`sed` 不支持 `e` 命令执行外部程序、`w /dev/stdout` 的所有情形；`diff` 的算法与 hunks 合并策略与 GNU 不完全一致；`find` 的 `-printf` 只覆盖常用转义。
- **排序/本地化**：`sort` 使用 JS 字符串比较，缺少完整 locale 排序规则（`LC_COLLATE`）。
- **日期**：`date` 只支持有限格式与 UTC；没有 `zdump`、时区文件。
- **归档**：`tar` 支持 ustar 常用子集；`zip` 写入为 STORED、读取支持 STORED/DEFLATE；`bzip2/xz/zstd` 没有压缩编解码器（会明确报错）；`gzip` 依赖 `CompressionStream`，缺失时明确失败。
- **加密**：`crypto` 仅实现 MD5/SHA-1/SHA-2/BLAKE2b（按实现情况）、HMAC、PBKDF2、AES-CBC；没有 RSA/ECDSA、证书、TLS、`createSign/Verify`、`scrypt`。

### 7. Node.js 运行时的具体缺口

“完整 Node.js”在浏览器里同样不可能：Node 的完整性依赖 V8、libuv、OpenSSL、zlib、c-ares、llhttp 等原生库，以及操作系统能力。本运行时是**用 JS 重新实现的兼容层**，不是 Node 本身：

- **CommonJS** 覆盖度高；**ESM** 通过静态语法转译支持常见 `import/export`，不支持所有边界语法（如 `import.meta` 的完整语义、复杂 re-export、`--experimental-loader`、包条件导出的全部组合）。
- **原生扩展（`.node`）** 完全不可用；`process.dlopen` 报错。
- **`worker_threads`** 不提供并行，只在同一线程内做消息模拟；`cluster` 不存在。
- **`child_process`** 不是真正的进程：子进程在同一 JS 线程中通过 Shell 执行，`kill`、`stdio` 继承、`detached`、进程组语义都是近似的。
- **网络服务端**：`http.createServer`、`net.createServer`、`dgram`、`tls` 无法监听端口；客户端 HTTP 依赖 `fetch`。
- **`fs.watch`/`inotify`**：没有真实事件源，watch 只返回占位 watcher；`fs.watchFile` 轮询亦未实现真实文件监听。
- **`vm`**：没有真正的隔离上下文与超时中断；`timeout` 选项被忽略。
- **`crypto`**：算法子集；没有 `createSign/createVerify`、`generateKeyPair`、X.509、`scrypt`、WebCrypto 之外的多数能力。
- **`zlib`**：纯 JS 实现，支持 stored/fixed/dynamic DEFLATE 解码；压缩采用 stored 块（体积不减小），性能远低于原生。
- **`stream`**：实现了常用类与 `pipe/pipeline`，但不是 Node 的完整背压、错误传播与对象模式语义。
- **`async_hooks`、`diagnostics_channel`、`inspector`、`trace_events`、`perf_hooks` 的细节**：不可用或仅有占位。
- **`process.binding`、`internal/*`**：不存在。
- **性能**：JS 实现比原生慢 1–3 个数量级；大文件、大量进程、复杂 `awk`/`sed` 脚本会明显变慢。
- **npm**：无 registry 访问；只能识别本地 `node_modules` 与 `package.json` 的简单脚本。

## 扩展

### 注册命令

```js
os.registerCommand('upper', {
  summary: 'uppercase stdin',
  usage: 'upper [TEXT...]',
  async run(c) {
    const s = c.args.length ? c.args.join(' ') : await c.readText();
    c.out(s.toUpperCase() + '\n');
    return 0;
  },
});
```

`c` 提供 `args/env/vfs/shell/cwd/uid/gid/stdin/stdout/stderr/out()/err()/readText()/readBytes()/cred()/cmdsub()/spawn()`。

### 接入真实二进制（可选）

如果你确实需要运行原生程序，可在宿主层做替换而不改本项目的命令语义：

1. **WASM**：把 busybox/coreutils 编译为 WASI 模块，实现一个 `CommandDef` 将 argv 与 stdio 桥接到 WASM 实例；VFS 需要提供 WASI `fd_read/fd_write/path_open` 适配。
2. **远程执行**：把 `exec` 后端换成容器/虚拟机 RPC（WebSocket/HTTP），本地保留 VFS 与 Shell 作为前端语法层。
3. **WebContainer 类运行时**：用第三方浏览器内 Linux 运行时替换 `kernel.commands` 中的命令实现。

本项目默认**不启用** WASM，保持“纯 JS、零二进制”的可审计性。

## 测试

```bash
cd webos
npm test
```

测试覆盖：内核/VFS/权限/`/proc`、挂载与只读挂载、系统调用、System V IPC、AF_UNIX、`fork/waitpid`、Shell 语法与执行、重定向与管道、变量与展开、控制流与函数、coreutils、文本处理、归档与校验和、系统命令（含 `su`/`sudo` 身份校验）、Node 运行时（`fs/path/crypto/zlib/Buffer/events`）、快照恢复以及端到端脚本。当前基线：**118 项断言全部通过**。另有一组 110 条命令的冒烟脚本，用于确认没有命令抛出内部异常（内部错误、类型错误、未实现调用）。

## 设计取舍

- **无 UI**：不创建 DOM、不渲染终端；输出是字符串/字节流，交互完全由调用方决定。
- **同构**：源码不 `import` Node 内置模块；同一份代码可在浏览器与 Node 中运行。
- **诚实**：无法实现的能力会明确失败并说明原因；不静默降级，不伪造成功。
