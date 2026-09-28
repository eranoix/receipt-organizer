import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Tidyslip', template: '%s | Tidyslip' },
  description: 'Organizes payment receipts and bills from a cloud drive: reads them, files them, spots duplicates and tracks what has been paid.',
};

const themeScript = `(function(){try{var m=document.cookie.match(/(?:^|; )ro_theme=(\\w+)/);var t=m?m[1]:'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = (await cookies()).get('ro_theme')?.value;
  return (
    <html lang="en" className={theme === 'dark' ? 'dark' : undefined} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
