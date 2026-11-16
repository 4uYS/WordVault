/* `os` module backed by the WebOS kernel rather than the host OS. */

export function createOs(kernel, getProc) {
  const proc = () => (typeof getProc === 'function' ? getProc() : null);
  const env = () => (proc()?.env) || {};
  const hostname = () => kernel?.hostname || 'webos';

  const os = {
    EOL: '\n',
    devNull: '/dev/null',
    platform: () => 'linux',
    arch: () => 'x64',
    type: () => 'Linux',
    release: () => '6.1.0-webos',
    version: () => '#1 SMP WebOS 1.0',
    machine: () => 'x86_64',
    hostname,
    homedir: () => env().HOME || '/home/user',
    tmpdir: () => '/tmp',
    endianness: () => 'LE',
    availableParallelism: () => 1,
    userInfo: (opts = {}) => {
      const p = proc();
      const uid = p?.uid ?? 1000;
      const user = kernel?.userByUid(uid);
      return {
        uid, gid: p?.gid ?? 1000,
        username: user?.name || env().USER || 'user',
        homedir: env().HOME || user?.home || '/home/user',
        shell: user?.shell || env().SHELL || '/bin/sh',
      };
    },
    cpus: () => [{
      model: 'WebOS Virtual CPU @ 2.4GHz',
      speed: 2400,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    }],
    totalmem: () => kernel?.memoryInfo?.().total ?? 512 * 1024 * 1024,
    freemem: () => kernel?.memoryInfo?.().free ?? 256 * 1024 * 1024,
    uptime: () => Math.floor(kernel?.uptime ?? (Date.now() / 1000)),
    loadavg: () => [0, 0, 0],
    networkInterfaces: () => ({
      lo: [{
        address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4',
        mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8',
      }],
    }),
    getPriority: () => 0,
    setPriority: () => {},
    getNetworkInterfaces: () => os.networkInterfaces(),
    constants: {
      signals: { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15, SIGPIPE: 13 },
      errno: { ENOENT: 2, EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22 },
      priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -10, PRIORITY_HIGH: -20 },
    },
  };
  return os;
}

export default createOs;
