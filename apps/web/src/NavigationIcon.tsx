const paths = [
  "M3 7h7l2 2h9v11H3z M3 7V4h7l2 3",
  "m14 3 7 7-4 4-3-3-9 10-3-3 10-9-3-3z",
  "M3 10V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v3 M3 10h18v11H3z M3 14h18 M10 12h4v5h-4z",
  "M8 5h13 M8 12h13 M8 19h13 M3 5h1 M3 12h1 M3 19h1",
  "m10 3-1 3-3 1-3 3 2 2-2 3 3 3 3 0 1 3h4l1-3 3-1 3-3-2-2 2-3-3-3-3 0-1-3z",
];
export function NavigationIcon({ index }: { index: number }) {
  return (
    <svg
      className="navigation-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[index]} />
      {index === 4 && <circle cx="12" cy="12" r="3" />}
    </svg>
  );
}
