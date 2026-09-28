import { extractPdfText } from '../render/pdf';
import { readPngText } from '../render/png';
import { PNG_TEXT_KEY } from '../render/receipt';

export function readTextLayer(bytes: Buffer, mime: string | null): string | null {
  if (mime === 'text/plain') return bytes.toString('utf8');
  const pdf = extractPdfText(bytes);
  if (pdf) return pdf;
  const png = readPngText(bytes);
  if (png) return png.text[PNG_TEXT_KEY] ?? null;
  return null;
}
