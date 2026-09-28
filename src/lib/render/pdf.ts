import { inflateSync } from 'node:zlib';

function esc(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export interface PdfLine { text: string; bold?: boolean; size?: number; invert?: boolean; rule?: boolean }

export function buildReceiptPdf(lines: PdfLine[], title: string): Buffer {
  const width = 300;
  const lineH = 14;
  const height = Math.max(260, 60 + lines.length * lineH);
  const ops: string[] = ['0.99 0.985 0.97 rg', `0 0 ${width} ${height} re f`];
  let y = height - 40;
  for (const l of lines) {
    if (l.invert) ops.push('0.13 0.15 0.17 rg', `18 ${y - 5} ${width - 36} ${lineH + 4} re f`);
    if (l.rule) {
      ops.push('0.55 0.55 0.55 RG', '[3 3] 0 d', `24 ${y + 4} m ${width - 24} ${y + 4} l S`, '[] 0 d');
    } else {
      const font = l.bold ? '/F2' : '/F1';
      ops.push(l.invert ? '1 1 1 rg' : '0.12 0.12 0.14 rg', 'BT', `${font} ${l.size ?? 9} Tf`, `26 ${y} Td`, `(${esc(l.text)}) Tj`, 'ET');
    }
    y -= lineH;
  }
  const content = ops.join('\n');

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    `<< /Title (${esc(title)}) /Producer (receipt-organizer fixture generator) >>`,
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function extractPdfText(buf: Buffer): string | null {
  const src = buf.toString('latin1');
  if (!src.startsWith('%PDF')) return null;
  const lines: string[] = [];
  const re = /<<((?:(?!<<|>>)[\s\S])*)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let body = m[2];
    if (/\/FlateDecode/.test(m[1])) {
      try { body = inflateSync(Buffer.from(body, 'latin1')).toString('latin1'); } catch { continue; }
    }
    for (const bt of body.split(/\bBT\b/).slice(1)) {
      const seg = bt.split(/\bET\b/)[0];
      const parts: string[] = [];
      const str = /\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")|\[((?:\\.|[^\]])*)\]\s*TJ/g;
      for (let s = str.exec(seg); s; s = str.exec(seg)) {
        if (s[1] !== undefined) parts.push(unesc(s[1]));
        else for (const p of s[2].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) parts.push(unesc(p[1]));
      }
      if (parts.length) lines.push(parts.join(''));
    }
  }
  return lines.length ? lines.join('\n') : null;
}

function unesc(s: string): string {
  return s.replace(/\\([\\()nrt])/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[c] ?? c);
}
