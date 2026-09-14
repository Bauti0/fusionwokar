// ============================================================
// Iconografía propia de la marca (line-art original, sin
// assets externos). Trazo en currentColor para poder tintar
// cada ícono desde CSS según dónde se use.
// ============================================================

export function IconBowlSteam(props) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" {...props}>
      <path d="M9 24h30a15 15 0 0 1-30 0Z" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M6 24h36" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path className="steam-line steam-line--1" d="M18 15c-2 2-2 3.5 0 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path className="steam-line steam-line--2" d="M24 12c-2 2-2 4 0 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path className="steam-line steam-line--3" d="M30 15c-2 2-2 3.5 0 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconChopsticks(props) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" {...props}>
      <path d="M14 8 34 40" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M20 8 40 40" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function IconDumpling(props) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" {...props}>
      <path d="M8 26c0-9 7-17 16-17s16 8 16 17c0 6-7 10-16 10S8 32 8 26Z" stroke="currentColor" strokeWidth="2.2" />
      <path d="M14 24c2.5-2 5-2 7 0M20 24c2.5-2 5-2 7 0M26 24c2.5-2 5-2 7 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconSearch(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function IconClock(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

export function IconSparkle(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
    </svg>
  );
}

export function IconEmptySearch(props) {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
      <circle cx="27" cy="27" r="16" stroke="currentColor" strokeWidth="2.4" />
      <path d="m39 39 12 12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M20 27h14M27 20v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
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
