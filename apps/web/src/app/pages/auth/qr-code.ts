import { ChangeDetectionStrategy, Component, input, resource } from '@angular/core';

/** An SVG path drawing every dark module of a QR matrix as a 1×1 square. */
export function qrPath(matrix: readonly (readonly boolean[])[]): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => row.forEach((dark, x) => dark && parts.push(`M${x} ${y}h1v1h-1z`)));
  return parts.join('');
}

/** A QR code for `value`, drawn as SVG (the encoder loads only when shown). */
@Component({
  selector: 'mt-qr-code',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: inline-block; line-height: 0' },
  template: `
    @if (qr.value(); as code) {
      <svg
        role="img"
        [attr.aria-label]="label()"
        [attr.viewBox]="'-2 -2 ' + (code.size + 4) + ' ' + (code.size + 4)"
        width="176"
        height="176"
        shape-rendering="crispEdges"
      >
        <rect x="-2" y="-2" [attr.width]="code.size + 4" [attr.height]="code.size + 4" fill="#ffffff" />
        <path [attr.d]="code.path" fill="#101218" />
      </svg>
    } @else {
      <span class="mt-shimmer" style="display: block; width: 176px; height: 176px" aria-hidden="true"></span>
    }
  `,
})
export class MtQrCode {
  readonly value = input.required<string>();
  readonly label = input('QR code');
  protected readonly qr = resource({
    params: () => this.value(),
    loader: async ({ params }) => {
      const { encode } = await import('uqr');
      const { data, size } = encode(params, { ecc: 'M', border: 0 });
      return { size, path: qrPath(data) };
    },
  });
}
