/* Registers every command group with the kernel. */

import { registerCoreutils } from './coreutils.js';
import { registerTextCommands } from './text.js';
import { registerSystemCommands } from './system.js';
import { registerArchiveCommands } from './archive.js';
import { registerMiscCommands } from './misc.js';

export function registerAllCommands(kernel) {
  registerCoreutils(kernel);
  registerTextCommands(kernel);
  registerSystemCommands(kernel);
  registerArchiveCommands(kernel);
  registerMiscCommands(kernel);
}
