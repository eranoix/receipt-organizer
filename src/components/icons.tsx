import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...p }: P, children: React.ReactNode) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
      {children}
    </svg>
  );
}

export const IconHome = (p: P) => base(p, <><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></>);
export const IconFolder = (p: P) => base(p, <path d="M3 6.5A1.5 1.5 0 014.5 5h4l2 2h9A1.5 1.5 0 0121 8.5v9a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z" />);
export const IconFolderOpen = (p: P) => base(p, <><path d="M3 7.5V6a1 1 0 011-1h4.5l2 2H19a1 1 0 011 1v2" /><path d="M3 19l2.5-8h16L19 19z" /></>);
export const IconInbox = (p: P) => base(p, <><path d="M3 13l2.5-7h13L21 13v5a1 1 0 01-1 1H4a1 1 0 01-1-1z" /><path d="M3 13h5l1.5 2.5h5L16 13h5" /></>);
export const IconFile = (p: P) => base(p, <><path d="M14 3H6.5A1.5 1.5 0 005 4.5v15A1.5 1.5 0 006.5 21h11a1.5 1.5 0 001.5-1.5V8z" /><path d="M14 3v5h5" /></>);
export const IconReceipt = (p: P) => base(p, <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6M9 16h3" /></>);
export const IconCheck = (p: P) => base(p, <path d="M5 12.5l4.5 4.5L19 7.5" />);
export const IconCopy = (p: P) => base(p, <><rect x="8" y="8" width="12" height="12" rx="1.5" /><path d="M16 8V5.5A1.5 1.5 0 0014.5 4h-9A1.5 1.5 0 004 5.5v9A1.5 1.5 0 005.5 16H8" /></>);
export const IconCalendar = (p: P) => base(p, <><rect x="3.5" y="5" width="17" height="15" rx="1.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>);
export const IconCard = (p: P) => base(p, <><rect x="3" y="5.5" width="18" height="13" rx="1.5" /><path d="M3 10h18M7 15h4" /></>);
export const IconActivity = (p: P) => base(p, <path d="M3 12h4l3-8 4 16 3-8h4" />);
export const IconGauge = (p: P) => base(p, <><path d="M4.5 18a9 9 0 1115 0" /><path d="M12 13l4-5" /><circle cx="12" cy="13" r="1" /></>);
export const IconSettings = (p: P) => base(p, <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" /></>);
export const IconUser = (p: P) => base(p, <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0116 0" /></>);
export const IconBell = (p: P) => base(p, <><path d="M6 16V11a6 6 0 1112 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 004 0" /></>);
export const IconSun = (p: P) => base(p, <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>);
export const IconMoon = (p: P) => base(p, <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" />);
export const IconLogout = (p: P) => base(p, <><path d="M15 4h3.5A1.5 1.5 0 0120 5.5v13a1.5 1.5 0 01-1.5 1.5H15" /><path d="M10 16l-4-4 4-4M6 12h10" /></>);
export const IconDownload = (p: P) => base(p, <><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5" /><path d="M4 19h16" /></>);
export const IconTrash = (p: P) => base(p, <><path d="M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13" /></>);
export const IconRefresh = (p: P) => base(p, <><path d="M20 11a8 8 0 00-14.5-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0014.5 4.5L20 16" /><path d="M20 20v-4h-4" /></>);
export const IconChevron = (p: P) => base(p, <path d="M9 6l6 6-6 6" />);
export const IconSearch = (p: P) => base(p, <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></>);
export const IconX = (p: P) => base(p, <path d="M6 6l12 12M18 6L6 18" />);
export const IconAlert = (p: P) => base(p, <><path d="M12 3.5L2.5 20h19z" /><path d="M12 10v4.5M12 17.5v.01" /></>);
export const IconPlus = (p: P) => base(p, <path d="M12 5v14M5 12h14" />);
export const IconPencil = (p: P) => base(p, <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>);
export const IconArrowRight = (p: P) => base(p, <path d="M5 12h14M13 6l6 6-6 6" />);
export const IconLink = (p: P) => base(p, <><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" /></>);
export const IconShield = (p: P) => base(p, <><path d="M12 3l7.5 3v6c0 4.5-3.2 7.8-7.5 9-4.3-1.2-7.5-4.5-7.5-9V6z" /><path d="M9 12l2 2 4-4" /></>);
export const IconSend = (p: P) => base(p, <><path d="M21 3L10 14" /><path d="M21 3l-7 18-4-7-7-4z" /></>);
export const IconFilter = (p: P) => base(p, <path d="M4 5h16l-6 7.5V19l-4 1.5v-8z" />);
export const IconGrip = (p: P) => base(p, <><circle cx="9" cy="6" r=".8" /><circle cx="15" cy="6" r=".8" /><circle cx="9" cy="12" r=".8" /><circle cx="15" cy="12" r=".8" /><circle cx="9" cy="18" r=".8" /><circle cx="15" cy="18" r=".8" /></>);
