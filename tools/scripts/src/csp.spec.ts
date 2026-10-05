import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  emulatorConfig,
  formatPolicy,
  hostingPolicy,
  main,
  parsePolicy,
  policyViolations,
  readFirebaseConfig,
  scriptHash,
  type FirebaseConfig,
} from './csp.ts';

const config = readFirebaseConfig();
const policy = parsePolicy(hostingPolicy(config));

describe('Hosting CSP (firebase.json)', () => {
  it('keeps the strict directives', () => {
    expect(policy.get('default-src')).toEqual(["'self'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    expect(policy.get('form-action')).toEqual(["'self'"]);
    expect(policy.get('script-src')).not.toContain("'unsafe-inline'");
    expect(policy.get('script-src')).not.toContain("'unsafe-eval'");
  });

  it('allows what the app needs: Firebase, reCAPTCHA, PDF.js and the auth popup', () => {
    expect(policy.get('connect-src')).toEqual(
      expect.arrayContaining(['https://*.googleapis.com', 'https://*.cloudfunctions.net']),
    );
    expect(policy.get('script-src')).toEqual(
      expect.arrayContaining(['https://apis.google.com', 'https://www.google.com/recaptcha/', "'wasm-unsafe-eval'"]),
    );
    expect(policy.get('img-src')).toContain('https://storage.googleapis.com');
    expect(policy.get('worker-src')).toEqual(["'self'", 'blob:']);
    for (const env of ['dev', 'staging', 'prod'])
      expect(policy.get('frame-src')).toContain(`https://materia-v2-${env}.firebaseapp.com`);
  });

  it('round-trips through parse and format', () => {
    expect(formatPolicy(policy)).toBe(hostingPolicy(config));
  });
});

describe('policyViolations', () => {
  const allowed = 'console.log(1)';
  const p = parsePolicy(`default-src 'self'; script-src 'self' ${scriptHash(allowed)}`);

  it('passes hashed inline scripts and external scripts', () => {
    expect(policyViolations(`<script>${allowed}</script><script src="main.js" type="module"></script>`, p)).toEqual([]);
  });

  it('reports unhashed inline scripts and inline event handlers', () => {
    const violations = policyViolations('<script>alert(1)</script><link rel="stylesheet" onload="x()">', p);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('alert(1)');
    expect(violations[1]).toContain('onload');
  });
});

describe('emulatorConfig', () => {
  it('adds the emulator origin to connect-src, img-src and frame-src only', () => {
    const e2e = parsePolicy(hostingPolicy(emulatorConfig(config)));
    for (const name of ['connect-src', 'img-src', 'frame-src']) expect(e2e.get(name)).toContain('http://127.0.0.1:*');
    expect(e2e.get('script-src')).toEqual(policy.get('script-src'));
    expect(hostingPolicy(config)).not.toContain('127.0.0.1');
  });
});

describe('main', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'materia-csp-'));

  it('check fails on a built index.html with an unhashed inline script', async () => {
    const html = path.join(dir, 'index.html');
    writeFileSync(html, '<html><script>alert(1)</script></html>');
    await expect(main(['check', '--html', html])).rejects.toThrow(/breaks the Hosting CSP/);
  });

  it('emulator-config writes the e2e config', async () => {
    const out = path.join(dir, 'firebase.e2e.json');
    await main(['emulator-config', '--out', out]);
    const written = JSON.parse(readFileSync(out, 'utf8')) as FirebaseConfig;
    expect(hostingPolicy(written)).toContain('http://127.0.0.1:*');
  });
});
