type IconProps = { className?: string };
const base = "h-5 w-5 shrink-0";
const svg = (className: string | undefined, children: React.ReactNode) => (
  <svg className={className ?? base} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const HomeIcon = ({ className }: IconProps) => svg(className, <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>);
export const TvIcon = ({ className }: IconProps) => svg(className, <><rect x="2" y="7" width="20" height="13" rx="2" /><path d="m7 7 5-4 5 4" /></>);
export const HeartIcon = ({ className }: IconProps) => svg(className, <path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1Z" />);
export const SearchIcon = ({ className }: IconProps) => svg(className, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></>);
export const UserIcon = ({ className }: IconProps) => svg(className, <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>);
export const ChevronDownIcon = ({ className }: IconProps) => svg(className ?? "h-4 w-4 shrink-0", <path d="m6 9 6 6 6-6" />);
export const ChevronLeftIcon = ({ className }: IconProps) => svg(className, <path d="m15 5-7 7 7 7" />);
export const ChevronRightIcon = ({ className }: IconProps) => svg(className, <path d="m9 5 7 7-7 7" />);
export const InfoIcon = ({ className }: IconProps) => svg(className, <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>);
// Filled triangle (Netflix-style Play) — fill, not stroke, so it reads solid at small sizes.
export const PlayIcon = ({ className }: IconProps) => (
  <svg className={className ?? base} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M6 4.5v15a.5.5 0 0 0 .77.42l12-7.5a.5.5 0 0 0 0-.84l-12-7.5A.5.5 0 0 0 6 4.5Z" />
  </svg>
);
