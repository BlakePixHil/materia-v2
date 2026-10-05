import { devMailFunction } from './mail';
import { isEmulator } from '../core/env';

/**
 * Development tools (FND-20). They exist only when the code runs in the Functions emulator, so a
 * deploy (which loads this module outside the emulator) never sees them.
 */
export const mail = isEmulator() ? devMailFunction() : undefined;
