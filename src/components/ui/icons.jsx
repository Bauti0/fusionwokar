// ============================================================
// Iconografía propia de la marca (line-art original, sin
// assets externos). Trazo en currentColor para poder tintar
// cada ícono desde CSS según dónde se use.
// ============================================================

export function IconBowlSteam({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      width={size ?? 48}
      height={size ?? 48}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M9 24h30a15 15 0 0 1-30 0Z" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M6 24h36" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path className="steam-line steam-line--1" d="M18 15c-2 2-2 3.5 0 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path className="steam-line steam-line--2" d="M24 12c-2 2-2 4 0 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path className="steam-line steam-line--3" d="M30 15c-2 2-2 3.5 0 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconChopsticks({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      width={size ?? 48}
      height={size ?? 48}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M14 8 34 40" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M20 8 40 40" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function IconDumpling({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      width={size ?? 48}
      height={size ?? 48}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M8 26c0-9 7-17 16-17s16 8 16 17c0 6-7 10-16 10S8 32 8 26Z" stroke="currentColor" strokeWidth="2.2" />
      <path d="M14 24c2.5-2 5-2 7 0M20 24c2.5-2 5-2 7 0M26 24c2.5-2 5-2 7 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconSearch({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function IconClock({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

export function IconRepeat({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

export function IconEdit({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

export function IconTrash({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function IconPlus({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconSparkle({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
    </svg>
  );
}

export function IconEmptySearch({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      width={size ?? 64}
      height={size ?? 64}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <circle cx="27" cy="27" r="16" stroke="currentColor" strokeWidth="2.4" />
      <path d="m39 39 12 12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M20 27h14M27 20v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}

export function IconArrowLeft({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M19 12H5M12 5l-7 7 7 7" />
    </svg>
  );
}

export function IconPhone({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export function IconMoney({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      width={size ?? 48}
      height={size ?? 48}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <rect x="6" y="10" width="36" height="28" rx="5" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="24" cy="24" r="6.5" stroke="currentColor" strokeWidth="2" />
      <path d="M14 18v2M34 28v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M6 17a6 6 0 0 0 6-6M42 31a6 6 0 0 1-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconBank({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      width={size ?? 48}
      height={size ?? 48}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M5 20h38L24 8 5 20Z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M9 20v15M18 20v15M30 20v15M39 20v15M6 38h36" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function IconCard({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      width={size ?? 48}
      height={size ?? 48}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <rect x="6" y="10" width="36" height="28" rx="5" stroke="currentColor" strokeWidth="2.2" />
      <path d="M6 19h36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M14 31c1.5 1.8 3.5 2.8 5.5 2.8 3 0 5-2.3 5-4.8 0-2.6-2-4-3.8-4.6-2.2-.8-4.2-1-4.2-3 0-1.6 1.5-2.8 3.2-2.8 1.8 0 3.4 1 4.6 2.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M35 26h1M22 26h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// Fondo decorativo: motivos dispersos, puramente ornamental
// (aria-hidden). Se usa en la portada y en el banner del menú
// para mantener la misma identidad visual.
export function HeroMotif({ className }) {
  return (
    <svg className={className} viewBox="0 0 400 420" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g opacity="0.16" stroke="#fff" fill="none">
        <circle cx="40" cy="70" r="26" strokeWidth="1.6" />
        <path d="M22 70h36M22 70a18 18 0 0 0 36 0" strokeWidth="1.6" strokeLinecap="round" />
      </g>
      <g opacity="0.14" stroke="var(--color-primary)" fill="none" transform="translate(310 40) rotate(18)">
        <path d="M0 0 20 32" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M8 0 28 32" strokeWidth="1.8" strokeLinecap="round" />
      </g>
      <g opacity="0.13" stroke="#fff" fill="none" transform="translate(330 260)">
        <path d="M-14 10c0-8 6-15 14-15s14 7 14 15c0 5-6 9-14 9s-14-4-14-9Z" strokeWidth="1.6" />
      </g>
      <g opacity="0.12" stroke="var(--color-primary)" fill="none" transform="translate(30 300)">
        <circle r="20" strokeWidth="1.6" />
      </g>
    </svg>
  );
}

// ============================================================
// Iconos de acción para botones (24x24, stroke currentColor)
// ============================================================

export function IconHome({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

export function IconStore({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

export function IconBike({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M6 18v-7.5a1 1 0 0 1 1-1h7.5a1 1 0 0 1 1 1H18" />
      <path d="M6 15h6" />
      <path d="M12 15v3" />
    </svg>
  );
}

export function IconCash({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M12 8v8" />
      <path d="M8 12h8" />
    </svg>
  );
}

export function IconTransfer({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 12v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
      <path d="M12 3v6" />
      <path d="M12 15v6" />
    </svg>
  );
}

export function IconCheck({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function IconX({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function IconMenu({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

export function IconArrowRight({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}

export function IconClockOutline({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function IconCalendar({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

export function IconLocation({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

export function IconUser({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export function IconReceipt({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

export function IconInfo({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

export function IconAlertCircle({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
export function IconCart({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <circle cx="4" cy="20" r="1" />
      <circle cx="19" cy="20" r="1" />
      <path d="M2 5h4.4l1.1 2.2L10 3h7l1 2h4a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h1.6Z" />
    </svg>
  );
}

export function IconScooter({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <circle cx="5.5" cy="18" r="1.5" />
      <circle cx="17.5" cy="18" r="1.5" />
      <path d="M2 18h4l1-4h8l1 4h2a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2Z" />
    </svg>
  );
}

// Ícono de reparto a domicilio: scooter (reicon, Outline, 24×24, MIT, dibujado a mano)
export function IconDelivery(props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" clipRule="evenodd" aria-hidden="true" {...props}>
      <path d="M13.864 5.783c-.313-.032-.72-.033-1.336-.033H12a.75.75 0 0 1 0-1.5h.565c.57 0 1.054 0 1.454.041c.425.044.819.14 1.19.37c.373.23.634.539.864.9c.202.318.406.72.64 1.189h1.155c.284 0 .545 0 .762.02c.235.02.49.069.738.21c.272.155.497.38.652.652c.141.248.19.503.21.738c.02.217.02.478.02.762v.093c0 .26.001.538-.083.802a1.8 1.8 0 0 1-.25.494c-.162.224-.386.389-.596.542l-.052.039l-.277.204l.487.974a3.75 3.75 0 1 1-4.154 4.47h-5.15a3.751 3.751 0 0 1-7.352-.009A1.75 1.75 0 0 1 1.25 14.92v-.057c0-.335 0-.548.015-.735a4.75 4.75 0 0 1 4.362-4.362c.187-.015.4-.015.735-.015h.69c.898 0 1.648 0 2.242.08c.628.084 1.195.27 1.65.726c.456.455.642 1.022.726 1.65c.08.594.08 1.344.08 2.242v.802h3.575a3.76 3.76 0 0 1 2.548-2.828l-2.438-4.875c-.276-.552-.458-.915-.628-1.18c-.16-.252-.274-.361-.386-.43c-.111-.07-.26-.123-.557-.154M10.25 15.25v-.75c0-.964-.002-1.612-.066-2.095c-.063-.461-.17-.659-.3-.789s-.328-.237-.79-.3c-.482-.064-1.13-.066-2.094-.066h-.6c-.386 0-.535 0-.655.01a3.25 3.25 0 0 0-2.985 2.985a10 10 0 0 0-.01.754c.01.122.129.24.25.25zm-5.872 1.5a2.25 2.25 0 0 0 4.244 0zM16.75 16a2.25 2.25 0 1 1 4.5 0a2.25 2.25 0 0 1-4.5 0m1.56-6.055l.07-.051c.138-.102.216-.16.272-.206l.05-.047a.3.3 0 0 0 .036-.07c-.002.006.004-.005.007-.069c.005-.073.005-.17.005-.341c0-.323 0-.515-.013-.657a.6.6 0 0 0-.022-.13a.25.25 0 0 0-.088-.09a.6.6 0 0 0-.131-.02a8 8 0 0 0-.657-.014h-.375z" />
    </svg>
  );
}

// Ícono de candado/pago seguro (reemplaza el emoji 🔒)
export function IconLock({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

// Ícono de rayo/envío rápido (reemplaza el emoji ⚡)
export function IconFlash({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M13 2l3 10h-6l3 10" />
    </svg>
  );
}

// Ícono de caja para llevar / para retirar (solapa y cinta cruzada)
export function IconTakeout({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <rect x="4" y="8" width="16" height="14" rx="1" />
      <path d="M4 8h16v-3H4z" />
      <line x1="12" y1="8" x2="12" y2="22" />
      <line x1="4" y1="15" x2="20" y2="15" />
    </svg>
  );
}

// Ícono de chat/WhatsApp (reemplaza el emoji 💬)
export function IconChat({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// Iconos para el botón de sonido en el header del panel admin
export function IconVolume2({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <polygon points="11 5 6 9 2 9 2 15 6 19 11 15 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

export function IconVolumeX({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <polygon points="11 5 6 9 2 9 2 15 6 19 11 15 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  );
}

// Chevron para dropdowns y paginadores (reemplaza SVG sueltos en DateRangePicker, DateTimePicker, Dropdown, Header)
export function IconChevronDown({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

// Pausa (reemplaza SVG inline en Menu.jsx:138)
export function IconPause({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
