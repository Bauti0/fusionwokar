// ============================================================
// Iconografía Lucide (line-art, stroke 2, currentColor)
// Trazo en currentColor para poder tintar cada ícono desde CSS.
// ============================================================

// Helper para crear íconos con firma unificada
function createIcon(paths, viewBox = "0 0 24 24", defaultSize = 24) {
  return function Icon({ size, ...props }) {
    const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
    return (
      <svg
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        width={size ?? defaultSize}
        height={size ?? defaultSize}
        {...props}
        aria-hidden={hasName ? undefined : "true"}
      >
        {paths}
      </svg>
    );
  };
}

// Íconos 24x24 base
export const IconCart = createIcon([
  <path key="p1" d="m2.05 2.05 1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18" />,
  <path key="p2" d="M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25" />,
  <circle key="c1" cx="18" cy="20" r="2" />,
  <circle key="c2" cx="8" cy="20" r="2" />,
]);

export const IconClock = createIcon([
  <circle key="c1" cx="12" cy="12" r="10" />,
  <path key="p1" d="M12 6v6l4 2" />,
]);

export const IconClockOutline = createIcon([
  <circle key="c1" cx="12" cy="12" r="10" />,
  <path key="p1" d="M12 6v6l4 2" />,
]);

export const IconArrowLeft = createIcon([
  <path key="p1" d="m15 18-6-6 6-6" />,
]);

export const IconArrowRight = createIcon([
  <path key="p1" d="m9 18 6-6-6-6" />,
]);

export const IconSearch = createIcon([
  <path key="p1" d="m21 21-4.34-4.34" />,
  <circle key="c1" cx="11" cy="11" r="8" />,
]);

export const IconLocation = createIcon([
  <path key="p1" d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />,
  <circle key="c1" cx="12" cy="10" r="3" />,
]);

export const IconPhone = createIcon([
  <path key="p1" d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384" />,
]);

export const IconChat = createIcon([
  <path key="p1" d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />,
]);

export const IconDelivery = createIcon([
  <path key="p1" d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />,
  <path key="p2" d="M15 18H9" />,
  <path key="p3" d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />,
  <circle key="c1" cx="17" cy="18" r="2" />,
  <circle key="c2" cx="7" cy="18" r="2" />,
]);

export const IconTakeout = createIcon([
  <path key="p1" d="M5.364 3.848C4 6 3 9.652 3 12.652V19a2 2 0 002 2h14a2 2 0 002-2v-5c0-2.334-1.816-4.668-2.622-7.002" />,
  <path key="p2" d="M7 3h11.379a2 2 0 011.789 1.106l.723 1.447A1 1 0 0119.997 7h-8.525a2 2 0 01-1.789-1.106L8.79 4.105a2 2 0 10-3.579 1.789l2.261 4.522A5 5 0 018 12.652V21" />,
]);


export const IconFlash = createIcon([
  <path key="p1" d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z" />,
]);

export const IconHome = createIcon([
  <path key="p1" d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />,
  <path key="p2" d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
]);

export const IconStore = createIcon([
  <path key="p1" d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5" />,
  <path key="p2" d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244" />,
  <path key="p3" d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05" />,
]);

export const IconCash = createIcon([
  <rect key="r1" width="20" height="12" x="2" y="6" rx="2" />,
  <circle key="c1" cx="12" cy="12" r="2" />,
  <path key="p1" d="M6 12h.01M18 12h.01" />,
]);

export const IconCard = createIcon([
  <rect key="r1" width="20" height="14" x="2" y="5" rx="2" />,
  <line key="l1" x1="2" x2="22" y1="10" y2="10" />,
  <path key="p1" d="M6 14h2" />,
]);

export const IconTransfer = createIcon([
  <path key="p1" d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />,
  <path key="p2" d="m21.854 2.147-10.94 10.939" />,
]);

export const IconMoney = createIcon([
  <path key="p1" d="M12 3v18" />,
  <path key="p2" d="M17 5H9.5a1 1 0 000 7h5a1 1 0 010 7H6" />,
]);

export const IconInfo = createIcon([
  <circle key="c1" cx="12" cy="12" r="10" />,
  <path key="p1" d="M12 16v-4" />,
  <path key="p2" d="M12 8h.01" />,
]);

export const IconUser = createIcon([
  <path key="p1" d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />,
  <circle key="c1" cx="12" cy="7" r="4" />,
]);

export const IconBank = createIcon([
  <path key="p1" d="M10 18v-7" />,
  <path key="p2" d="M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z" />,
  <path key="p3" d="M14 18v-7" />,
  <path key="p4" d="M18 18v-7" />,
  <path key="p5" d="M3 22h18" />,
  <path key="p6" d="M6 18v-7" />,
]);

export const IconLock = createIcon([
  <circle key="c1" cx="12" cy="16" r="1" />,
  <rect key="r1" x="3" y="10" width="18" height="12" rx="2" />,
  <path key="p1" d="M7 10V7a5 5 0 0 1 10 0v3" />,
]);

export const IconCheck = createIcon([
  <path key="p1" d="M20 6 9 17l-5-5" />,
]);

export const IconX = createIcon([
  <path key="p1" d="M18 6 6 18" />,
  <path key="p2" d="m6 6 12 12" />,
]);

export const IconRepeat = createIcon([
  <path key="p1" d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />,
  <path key="p2" d="M3 3v5h5" />,
]);

export const IconTrash = createIcon([
  <path key="p1" d="M10 11v6" />,
  <path key="p2" d="M14 11v6" />,
  <path key="p3" d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />,
  <path key="p4" d="M3 6h18" />,
  <path key="p5" d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />,
]);

export const IconEdit = createIcon([
  <path key="p1" d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />,
]);

export const IconPlus = createIcon([
  <path key="p1" d="M5 12h14" />,
  <path key="p2" d="M12 5v14" />,
]);

export const IconReceipt = createIcon([
  <path key="p1" d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />,
  <path key="p2" d="M14 2v5a1 1 0 0 0 1 1h5" />,
  <path key="p3" d="M10 9H8" />,
  <path key="p4" d="M16 13H8" />,
  <path key="p5" d="M16 17H8" />,
]);

export const IconTag = createIcon([
  <path key="p1" d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />,
  <circle key="c1" cx="7.5" cy="7.5" r=".5" fill="currentColor" />,
]);

export const IconChart = createIcon([
  <path key="p1" d="M3 3v16a2 2 0 0 0 2 2h16" />,
  <path key="p2" d="M18 17V9" />,
  <path key="p3" d="M13 17V5" />,
  <path key="p4" d="M8 17v-3" />,
]);

export const IconBell = createIcon([
  <path key="p1" d="M10.268 21a2 2 0 0 0 3.464 0" />,
  <path key="p2" d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />,
]);

export const IconAlertCircle = createIcon([
  <circle key="c1" cx="12" cy="12" r="10" />,
  <line key="l1" x1="12" x2="12" y1="8" y2="12" />,
  <line key="l2" x1="12" x2="12.01" y1="16" y2="16" />,
]);

export const IconSparkle = createIcon([
  <path key="p1" d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />,
  <path key="p2" d="M20 2v4" />,
  <path key="p3" d="M22 4h-4" />,
  <circle key="c1" cx="4" cy="20" r="2" />,
], "0 0 24 24", 64);

// Íconos 48x48 (marca)
export function IconBowlSteam({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M11.248 3c.273.1.808.53.747 1.36-.05.83-.938 1.2-.989 2.02-.06.78.333 1.24.727 1.62" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.252 3c.268.1.794.53.745 1.36-.06.83-.923 1.2-.993 2.02-.05.78.338 1.24.725 1.62" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.5 12 22 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 12a1 1 0 00-.99 1.133A9 9 0 0012 21a9 9 0 008.99-7.867A1 1 0 0020 12z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.252 3c.268.1.794.53.745 1.36-.06.83-.923 1.2-.993 2.02-.05.78.338 1.24.735 1.62" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 21h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconChopsticks({ size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      width={size ?? 24}
      height={size ?? 24}
      {...props}
      aria-hidden={hasName ? undefined : "true"}
    >
      <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 2v20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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
      <circle cx="24" cy="24" r="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M24 12c6.6 0 12 5.4 12 12s-5.4 12-12 12-12-5.4-12-12 5.4-12 12-12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 24h12M24 18v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
      <circle cx="32" cy="32" r="24" stroke="currentColor" strokeWidth="2" />
      <path d="M16 16 48 48M48 16 16 48" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// IconOrderStatus (7 estados + desconocido)
export function IconOrderStatus({ status, size, ...props }) {
  const hasName = props["aria-label"] || props["aria-labelledby"] || props["title"];

  const custom = {
    received: (
      <>
        <rect x="6" y="6" width="12" height="14" rx="1" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <line x1="9" y1="10" x2="15" y2="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <line x1="9" y1="12" x2="13" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <line x1="9" y1="14" x2="14" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </>
    ),
    preparing: (
      <>
        <path d="M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M6 17h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </>
    ),
    out_for_delivery: (
      <>
        <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M15 18H9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="17" cy="18" r="2" stroke="currentColor" strokeWidth="2" />
        <circle cx="7" cy="18" r="2" stroke="currentColor" strokeWidth="2" />
      </>
    ),
    completed: (
      <>
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
        <path d="m16 9-5.5 5.5L8 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  };

  const builtIn = {
    ready: <IconCheck size={size} {...props} />,
    cancelled: <IconX size={size} {...props} />,
    pending_payment: <IconClockOutline size={size} {...props} />,
  };

  if (builtIn[status]) {
    return builtIn[status];
  }

  const content = custom[status] ?? (
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
  );

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
      {content}
    </svg>
  );
}

// Chevron para dropdowns (Header, DatePickers, Dropdown)
export const IconChevronDown = createIcon([
  <path key="p1" d="m6 9 6 6 6-6" />,
]);

// Volumen (para control de sonido en panel admin)
export const IconVolume2 = createIcon([
  <path key="p1" d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />,
  <path key="p2" d="M16 9a5 5 0 0 1 0 6" />,
  <path key="p3" d="M19.364 18.364a9 9 0 0 0 0-12.728" />,
]);

// Silenciado: parlante + X SOLO. Acá estaba el bug de superposición: este
// ícono tenía TAMBIÉN los arcos de ondas del volumen normal (p2/p3 de
// IconVolume2), así que el estado "silenciado" mostraba el parlante con
// ondas y una X cruzada encima (verificado en el DOM: 5 paths en el mismo
// svg). El volume-x de Lucide es parlante + X, sin ondas.
export const IconVolumeX = createIcon([
  <path key="p1" d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />,
  <line key="l1" x1="22" y1="9" x2="16" y2="15" />,
  <line key="l2" x1="16" y1="9" x2="22" y2="15" />,
]);

// Pausa (para estado de cocina pausada)
export const IconPause = createIcon([
  <circle key="c1" cx="12" cy="12" r="10" />,
  <line key="l1" x1="10" x2="10" y1="15" y2="9" />,
  <line key="l2" x1="14" x2="14" y1="15" y2="9" />,
]);

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