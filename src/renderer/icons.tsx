// Small inline SVG icons (24×24 grid, stroked), drawn here so the app needs no icon library.
import type { ReactNode } from 'react';

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const RefreshIcon = () => (
  <Icon>
    <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
    <path d="M20 20v-4h-4" />
  </Icon>
);

export const PinIcon = ({ filled }: { filled?: boolean }) => (
  <Icon>
    <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z" fill={filled ? 'currentColor' : 'none'} />
    <path d="M12 14v6" />
  </Icon>
);

export const SunIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);

export const MoonIcon = () => (
  <Icon>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </Icon>
);

export const MonitorIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </Icon>
);

export const MoreIcon = () => (
  <Icon>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" />
  </Icon>
);

export const PencilIcon = () => (
  <Icon size={14}>
    <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
    <path d="m13.5 6.5 4 4" />
  </Icon>
);

export const ChevronIcon = ({ open }: { open: boolean }) => (
  <Icon size={16}>
    <path d={open ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'} />
  </Icon>
);

/** Pull request: two branches joining. */
export const PullRequestIcon = () => (
  <Icon size={20}>
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="18" r="2.2" />
    <path d="M6 8.2v7.6" />
    <path d="M18 15.8V9a3 3 0 0 0-3-3h-4" />
    <path d="m13 4-2 2 2 2" />
  </Icon>
);

/** Review: an eye with a tick. */
export const ReviewIcon = () => (
  <Icon size={20}>
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);

/** Needs reviewers: two people, one dashed. */
export const ReviewersIcon = () => (
  <Icon size={20}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3 20a6 6 0 0 1 12 0" />
    <circle cx="17" cy="9" r="2.5" strokeDasharray="2 2" />
    <path d="M17 14a5 5 0 0 1 4 5" strokeDasharray="2 2" />
  </Icon>
);

/** Waiting on you: an hourglass. */
export const WaitingIcon = () => (
  <Icon size={20}>
    <path d="M7 3h10M7 21h10" />
    <path d="M8 3v3a4 4 0 0 0 1.6 3.2L12 11l2.4-1.8A4 4 0 0 0 16 6V3" />
    <path d="M8 21v-3a4 4 0 0 1 1.6-3.2L12 13l2.4 1.8A4 4 0 0 1 16 18v3" />
  </Icon>
);

/** History: a clock with a backwards arrow. */
export const HistoryIcon = () => (
  <Icon size={20}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
    <path d="M3 4v4h4" />
    <path d="M12 8v4l3 2" />
  </Icon>
);

export const KeyIcon = () => (
  <Icon size={20}>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 9-9M17 6l3 3M15 8l2 2" />
  </Icon>
);

export const ExternalIcon = () => (
  <Icon size={13}>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

/** Group by repo: stacked rows. */
export const GroupIcon = () => (
  <Icon size={14}>
    <rect x="3" y="4" width="18" height="6" rx="1.5" />
    <rect x="3" y="14" width="18" height="6" rx="1.5" />
  </Icon>
);

/** Sort: an arrow pointing the way the dates run (down = oldest first, up = newest first). */
export const SortIcon = ({ descending }: { descending: boolean }) => (
  <Icon size={14}>
    <path d="M4 6h9M4 12h6M4 18h3" />
    <path d={descending ? 'M18 19V5m-3 3 3-3 3 3' : 'M18 5v14m-3-3 3 3 3-3'} />
  </Icon>
);

/** Filter: a funnel. */
export const FilterIcon = () => (
  <Icon size={14}>
    <path d="M4 5h16l-6 7.5V19l-4-2v-4.5L4 5Z" />
  </Icon>
);

/** Your PRs waiting: an outbox, things you've sent out. */
export const OutboxIcon = () => (
  <Icon size={20}>
    <path d="M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
    <path d="M4 13h4l1.5 2.5h5L16 13h4" />
    <path d="M12 3v8M8.5 6.5 12 3l3.5 3.5" />
  </Icon>
);

export const CopyIcon = () => (
  <Icon size={14}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon size={14}>
    <path d="m5 12 5 5 9-10" />
  </Icon>
);
