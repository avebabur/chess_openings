const PATHS = {
  chevron: 'M9 6l6 6-6 6',
  pencil: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  play: 'M7 5v14l11-7z',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l4 4L19 6',
  x: 'M6 6l12 12M18 6L6 18',
}

/** Lightweight inline-SVG icon set (outline, stroke = currentColor). */
export default function Icon({ name, size = 16, className = '', filled = false }) {
  const d = PATHS[name]
  if (!d) return null
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}
