import { InjectionToken } from '@angular/core';

/** The browser, as the Claude connector needs it: the app's origin, leaving for Claude, copying. */
export interface ConnectorBrowser {
  origin(): string;
  assign(url: string): void;
  copy(text: string): Promise<void>;
}

/** The Claude connector's browser (INT-07). Tests replace it. */
export const CONNECTOR_BROWSER = new InjectionToken<ConnectorBrowser>('CONNECTOR_BROWSER', {
  providedIn: 'root',
  factory: () => ({
    origin: () => globalThis.location.origin,
    assign: (url: string) => globalThis.location.assign(url),
    copy: (text: string) => globalThis.navigator.clipboard.writeText(text),
  }),
});
