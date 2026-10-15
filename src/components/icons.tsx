// Small line icons in one stroke style (1.3px, currentColor) so the chrome reads as one set.
const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export const FolderIcon = () => (
  <svg width="14" height="12" viewBox="0 0 15 12" {...base}>
    <path d="M1 2.2c0-.66.54-1.2 1.2-1.2h3.3l1.4 1.6h5.9c.66 0 1.2.54 1.2 1.2v6.5c0 .66-.54 1.2-1.2 1.2H2.2c-.66 0-1.2-.54-1.2-1.2z" />
  </svg>
);

// Xcode-style "show/hide inspector" glyph: a window with its right-hand pane marked.
export const PaneIcon = () => (
  <svg width="15" height="13" viewBox="0 0 16 14" {...base}>
    <rect x="0.65" y="0.65" width="14.7" height="12.7" rx="2.5" />
    <line x1="10" y1="1" x2="10" y2="13" />
  </svg>
);

export const ShieldIcon = () => (
  <svg width="12" height="13" viewBox="0 0 12 13" {...base}>
    <path d="M6 1 1.5 2.8v3.4c0 2.8 1.9 4.9 4.5 5.8 2.6-.9 4.5-3 4.5-5.8V2.8z" />
  </svg>
);

export const BoltIcon = () => (
  <svg width="11" height="13" viewBox="0 0 11 13" {...base}>
    <path d="M6.5 1 1.5 7.2h4L4.5 12l5-6.2h-4z" />
  </svg>
);

export const SparkIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...base}>
    {/* A four-point sparkle and a small one beside it (not radiating lines, which read as a loading spinner). */}
    <path d="M5.3 3Q5.9 6.7 9.8 7.3Q5.9 7.9 5.3 11.3Q4.7 7.9 0.8 7.3Q4.7 6.7 5.3 3Z" />
    <path d="M9.6 1Q9.8 2.1 11 2.3Q9.8 2.5 9.6 3.6Q9.4 2.5 8.2 2.3Q9.4 2.1 9.6 1Z" />
  </svg>
);

export const BranchIcon = () => (
  <svg width="11" height="13" viewBox="0 0 11 13" {...base}>
    <circle cx="2.5" cy="2.5" r="1.5" />
    <circle cx="2.5" cy="10.5" r="1.5" />
    <circle cx="8.5" cy="4.5" r="1.5" />
    <path d="M2.5 4v5M8.5 6c0 2-2 2.5-6 3" />
  </svg>
);

export const PlusIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" {...base}>
    <path d="M6.5 2v9M2 6.5h9" />
  </svg>
);

export const ClockIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" {...base}>
    <circle cx="7" cy="7" r="5.6" />
    <path d="M7 4v3.2l2.1 1.3" />
  </svg>
);

export const ArrowUpIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...base} strokeWidth={1.6}>
    <path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" />
  </svg>
);

// Plan first: a short checklist.
export const PlanIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...base}>
    <path d="M1.5 2.5l1 1 1.6-1.8M6 3h4.5M1.5 7l1 1 1.6-1.8M6 7.5h4.5M6 10.5h4.5" />
  </svg>
);

// Debug: a small bug.
export const BugIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...base}>
    <path d="M4 3.2a2 2 0 0 1 4 0M3.4 4.4h5.2v2.8a2.6 2.6 0 0 1-5.2 0zM6 4.4V10M1.5 5.2l1.9.6M10.5 5.2l-1.9.6M1.5 8.6l1.9-.5M10.5 8.6l-1.9-.5" />
  </svg>
);

// A document with a folded corner, like the file icons in Xcode's jump bar.
export const DocIcon = () => (
  <svg width="11" height="13" viewBox="0 0 11 13" {...base}>
    <path d="M1.5 1.8c0-.44.36-.8.8-.8h4.2l3 3v7.2c0 .44-.36.8-.8.8H2.3a.8.8 0 0 1-.8-.8z" />
    <path d="M6.5 1v3h3" />
  </svg>
);

// An open folder, for expanded folders in the file tree.
export const FolderOpenIcon = () => (
  <svg width="14" height="12" viewBox="0 0 15 12" {...base}>
    <path d="M1 9.8V2.2c0-.66.54-1.2 1.2-1.2h3.3l1.4 1.6h4.7c.66 0 1.2.54 1.2 1.2v.9" />
    <path d="M1 9.8 2.9 5.3c.18-.43.6-.7 1.06-.7h9.4c.58 0 .98.6.75 1.14l-1.8 4.3c-.18.43-.6.71-1.07.71H2.2c-.66 0-1.2-.54-1.2-1.2z" />
  </svg>
);

// Glyphs for the toast shown when a turn ends.
export const HudCheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" {...base} strokeWidth={1.7}>
    <path d="M3 7.4 5.8 10.2 11 4" />
  </svg>
);

export const HudStopIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" {...base} strokeWidth={1.5}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
  </svg>
);

export const HudFailIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" {...base} strokeWidth={1.7}>
    <path d="M4 4l6 6M10 4 4 10" />
  </svg>
);

// A circled cross: steps that failed, in the title bar.
export const FailIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...base}>
    <circle cx="6" cy="6" r="5" />
    <path d="M4.2 4.2l3.6 3.6M7.8 4.2 4.2 7.8" />
  </svg>
);

// A raised hand: chats waiting for your answer, in the title bar.
export const WaitIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...base}>
    <circle cx="6" cy="6" r="5" />
    <path d="M6 3.4v3M6 8.4v.2" />
  </svg>
);

// Step by step: three stacked pages.
export const StepsIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...base}>
    <rect x="1.5" y="3.5" width="6" height="7" rx="1" />
    <path d="M4 1.5h5.5a1 1 0 0 1 1 1V8" />
  </svg>
);

// A ready update: a circular arrow, restart to take it.
export const RestartIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...base}>
    <path d="M10.2 6a4.2 4.2 0 1 1-1.3-3" />
    <path d="M9.4 1v2.2H7.2" />
  </svg>
);

export const InfoIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" {...base}>
    <circle cx="6.5" cy="6.5" r="5.6" />
    <line x1="6.5" y1="5.8" x2="6.5" y2="9.4" />
    <circle cx="6.5" cy="3.9" r="0.35" fill="currentColor" />
  </svg>
);

// Step by step's flavours (Debug has BugIcon). Build: a hammer.
export const BuildIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...base}>
    <path d="M6.6 5.4 1.8 10.2" />
    <path d="M4.6 2.3 6.2 1h2.2l2.1 2.1-1.6 1.6-1.4-1.4-1.3 1.3L4.6 2.9z" />
  </svg>
);

// Learn: an open book.
export const LearnIcon = () => (
  <svg width="13" height="12" viewBox="0 0 13 12" {...base}>
    <path d="M6.5 2.6C5.3 1.7 3.6 1.3 1.2 1.4v7.8c2.4-.1 4.1.3 5.3 1.2 1.2-.9 2.9-1.3 5.3-1.2V1.4c-2.4-.1-4.1.3-5.3 1.2z" />
    <line x1="6.5" y1="2.6" x2="6.5" y2="10.4" />
  </svg>
);

// Review: a magnifier over lines.
export const ReviewIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...base}>
    <circle cx="5.2" cy="5.2" r="3.7" />
    <line x1="7.9" y1="7.9" x2="10.8" y2="10.8" />
    <line x1="3.6" y1="4.4" x2="6.8" y2="4.4" />
    <line x1="3.6" y1="6" x2="5.8" y2="6" />
  </svg>
);

// Architecture: three boxes joined by lines.
export const ArchitectureIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...base}>
    <rect x="4.2" y="0.9" width="3.6" height="3" rx="0.8" />
    <rect x="0.9" y="8.1" width="3.6" height="3" rx="0.8" />
    <rect x="7.5" y="8.1" width="3.6" height="3" rx="0.8" />
    <path d="M6 3.9v2M2.7 8.1v-2.1h6.6v2.1" />
  </svg>
);

// Three agents joined to one: the canvas of an orchestra.
export const CanvasIcon = () => (
  <svg width="15" height="14" viewBox="0 0 15 14" {...base}>
    <rect x="0.8" y="4.9" width="4.4" height="4.2" rx="1.2" />
    <rect x="9.8" y="0.8" width="4.4" height="4.2" rx="1.2" />
    <rect x="9.8" y="9" width="4.4" height="4.2" rx="1.2" />
    <path d="M5.2 7h1.6c1.6 0 1.6-4.1 3-4.1M5.2 7h1.6c1.6 0 1.6 4.1 3 4.1" />
  </svg>
);

// A main agent with a worker branching off it: start an orchestra.
export const OrchestraIcon = () => (
  <svg width="15" height="14" viewBox="0 0 15 14" {...base}>
    <rect x="0.8" y="4.9" width="4.4" height="4.2" rx="1.2" />
    <rect x="9.8" y="2.6" width="4.4" height="4.2" rx="1.2" />
    <path d="M5.2 7h1.6c1.2 0 1.2-2.3 3-2.3" />
    <path d="M12 9.4v3.2M10.4 11h3.2" />
  </svg>
);

// An arrow leaving a frame: open an agent full size.
export const OpenOutIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...base}>
    <path d="M5 2H2.6C1.7 2 1 2.7 1 3.6v5.8C1 10.3 1.7 11 2.6 11h5.8c.9 0 1.6-.7 1.6-1.6V7" />
    <path d="M7 1h4v4M11 1 5.5 6.5" />
  </svg>
);

export const ChevronIcon = ({ up = false }: { up?: boolean }) => (
  <svg width="11" height="11" viewBox="0 0 11 11" {...base}>
    <path d={up ? "M2.2 6.8 5.5 3.5l3.3 3.3" : "M2.2 4.2 5.5 7.5l3.3-3.3"} />
  </svg>
);

// A cog: Settings.
export const GearIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" {...base}>
    <circle cx="7" cy="7" r="2" />
    <path d="M7 1.2v1.6M7 11.2v1.6M1.2 7h1.6M11.2 7h1.6M2.9 2.9l1.15 1.15M9.95 9.95l1.15 1.15M2.9 11.1l1.15-1.15M9.95 4.05l1.15-1.15" />
    <circle cx="7" cy="7" r="4.2" />
  </svg>
);

// Xcode's "show/hide navigator": a window with its left-hand pane marked.
export const SidebarIcon = () => (
  <svg width="15" height="13" viewBox="0 0 16 14" {...base}>
    <rect x="0.65" y="0.65" width="14.7" height="12.7" rx="2.5" />
    <line x1="6" y1="1" x2="6" y2="13" />
  </svg>
);

// A diamond: a team, in the sidebar.
export const TeamIcon = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" {...base}>
    <path d="M5.5 1 10 5.5 5.5 10 1 5.5z" />
  </svg>
);

// A pushpin: a pinned chat.
export const PinIcon = () => (
  <svg width="10" height="11" viewBox="0 0 10 11" {...base}>
    <path d="M3.2 1h3.6l-.5 3 1.7 1.7H2L3.7 4zM5 5.7V10" />
  </svg>
);
