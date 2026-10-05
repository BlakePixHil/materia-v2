import { createLog } from './core/http';
import { converter } from './preview/convert';
import { previewServer } from './preview/server';

/**
 * The preview service (CORE-12a, ADR-028), the container's entry point: Office → PDF with
 * LibreOffice headless and HEIC → JPEG with heif-convert, served on $PORT.
 */

const log = createLog({ service: 'preview' });
const port = Number(process.env['PORT'] ?? 8080);

previewServer({
  convert: converter({
    soffice: process.env['SOFFICE_PATH'] ?? 'soffice',
    heifConvert: process.env['HEIF_CONVERT_PATH'] ?? 'heif-convert',
  }),
  log,
  maxBytes: 55 * 1024 * 1024,
}).listen(port, () => log.info('listening', { port }));
