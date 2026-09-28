'use client';

import { IconDownload, IconFile } from './icons';

export function Preview({ fileId, name, mime, height = 420 }: { fileId: string; name: string; mime: string | null; height?: number }) {
  const src = `/api/files/${encodeURIComponent(fileId)}/content`;
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-sunken">
      <div className="flex items-center justify-center" style={{ height }}>
        {mime?.startsWith('image/') ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={`Preview of ${name}`} className="max-h-full max-w-full object-contain p-2" />
        ) : mime === 'application/pdf' ? (
          <iframe src={`${src}#toolbar=0&view=FitH`} title={`Preview of ${name}`} className="h-full w-full bg-white" />
        ) : (
          <div className="text-center text-sm text-muted"><IconFile size={28} className="mx-auto mb-2" />No preview for this file type</div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-line bg-panel px-3 py-1.5 text-xs">
        <span className="truncate text-muted" title={name}>{name}</span>
        <a className="flex items-center gap-1 text-accent hover:underline" href={`${src}?download=1`}><IconDownload size={12} />Download</a>
      </div>
    </div>
  );
}
