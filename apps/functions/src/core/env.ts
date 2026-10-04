/** Running in the Firebase emulator suite (set by the Functions emulator). */
export function isEmulator(): boolean {
  return process.env['FUNCTIONS_EMULATOR'] === 'true';
}

/** Use in-memory fakes for external services: in the emulator, or when MATERIA_FAKES=1. */
export function useFakes(): boolean {
  return isEmulator() || process.env['MATERIA_FAKES'] === '1';
}

/** The release this code was built from, set by the deploy pipeline (FND-05). */
export function releaseInfo(): { version: string; sha: string } {
  return {
    version: process.env['MATERIA_RELEASE_VERSION'] ?? '0.0.0-dev',
    sha: process.env['MATERIA_RELEASE_SHA'] ?? 'unknown',
  };
}
