import type { Auth } from 'firebase/auth';

import { onDemandPopups } from './firebase-auth-port';

/** Stands in for Firebase's pop-up helper, which unit tests (Firebase Auth's Node build) don't have. */
class FirebasePopups {
  static early = true;
  static load = vi.fn<(auth: Auth) => Promise<unknown>>();

  get _shouldInitProactively(): boolean {
    return FirebasePopups.early;
  }

  _initialize(auth: Auth): Promise<unknown> {
    return FirebasePopups.load(auth);
  }
}

describe('onDemandPopups', () => {
  const auth = {} as Auth;
  beforeEach(() => {
    FirebasePopups.early = true;
    FirebasePopups.load.mockReset().mockResolvedValue({});
  });

  it('never asks Auth to load the helper as it starts, and keeps the instance Auth makes', () => {
    const Popups = onDemandPopups(FirebasePopups);
    const popups = new Popups();
    expect(popups._shouldInitProactively).toBe(false);
    expect(Popups.latest).toBe(popups);
  });

  it('loads it on prepare only where Firebase would have loaded it as Auth started', async () => {
    const popups = new (onDemandPopups(FirebasePopups))();
    await popups.prepare(auth);
    expect(FirebasePopups.load).toHaveBeenCalledExactlyOnceWith(auth);

    FirebasePopups.load.mockClear();
    FirebasePopups.early = false;
    await popups.prepare(auth);
    expect(FirebasePopups.load).not.toHaveBeenCalled();
  });

  it('settles quietly when the helper can’t load (the pop-up tries again when tapped)', async () => {
    const popups = new (onDemandPopups(FirebasePopups))();
    FirebasePopups.load.mockRejectedValue(new Error('offline'));
    await expect(popups.prepare(auth)).resolves.toBeUndefined();
    FirebasePopups.load.mockImplementation(() => {
      throw new TypeError('renamed');
    });
    await expect(popups.prepare(auth)).resolves.toBeUndefined();
  });
});
