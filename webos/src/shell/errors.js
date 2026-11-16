/* Shell error / control-flow types shared by the executor and builtins. */

export class ShellExit extends Error {
  constructor(code = 0) { super(`exit ${code}`); this.name = 'ShellExit'; this.code = code; }
}
export class ShellReturn extends Error {
  constructor(code = 0) { super(`return ${code}`); this.name = 'ShellReturn'; this.code = code; }
}
export class ShellBreak extends Error {
  constructor(levels = 1) { super(`break ${levels}`); this.name = 'ShellBreak'; this.levels = levels; }
}
export class ShellContinue extends Error {
  constructor(levels = 1) { super(`continue ${levels}`); this.name = 'ShellContinue'; this.levels = levels; }
}
export class CommandError extends Error {
  constructor(message, code = 1, { usage = false } = {}) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.usage = usage;
  }
}
export function cmdFail(message, code = 1) { throw new CommandError(message, code); }
