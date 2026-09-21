/**
 * The brand mark, inlined rather than loaded from /public.
 *
 * WHY INLINE. This is the same artwork as public/icon.svg, which is drawn with `currentColor` so it
 * can follow the theme. That works only when the SVG is part of the document. Loaded through
 * `next/image` it becomes an `<img src>`, and an SVG inside an `<img>` is an isolated document: it
 * cannot see the page's colour, so `currentColor` fell back to its initial value — black — and the
 * mark was all but invisible against the dark background.
 *
 * A `prefers-color-scheme` block inside the file would not fix it either, because this app switches
 * theme with a `.dark` class rather than following the operating system. It would have kept the mark
 * dark for anyone running a light OS with the app in dark mode. Inlining makes `currentColor` resolve
 * against the header's own text colour, so the mark tracks the real theme in both directions.
 *
 * public/icon.svg stays for the favicon, where there is no document to inherit from and the colour is
 * therefore hard-coded.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={26}
      height={26}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={className}
    >
      {/* central conformed node */}
      <circle cx="16" cy="16" r="3.2" fill="currentColor" stroke="none" />
      {/* four satellite entities: supplier, plant, shipment, customer */}
      <circle cx="16" cy="4.6" r="2.4" />
      <circle cx="27.4" cy="16" r="2.4" />
      <circle cx="16" cy="27.4" r="2.4" />
      <circle cx="4.6" cy="16" r="2.4" />
      {/* declared relationships */}
      <path d="M16 7v5.8M19.2 16h5.8M16 19.2V25M7 16h5.8" />
      {/* hierarchy edges, held back so they read as secondary */}
      <path
        d="M18.3 6.9 25.5 14.1M25.5 17.9 18.3 25.1M13.7 25.1 6.5 17.9M6.5 14.1 13.7 6.9"
        opacity="0.45"
      />
    </svg>
  )
}
