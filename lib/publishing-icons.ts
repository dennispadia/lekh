const paths: Record<string, string> = {
  note: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.5"/>',
  tip: '<path d="M8 16c0-2-3-3-3-7a7 7 0 0 1 14 0c0 4-3 5-3 7M8 16h8M9 19h6M10 22h4"/>',
  important: '<path d="m12 2 10 10-10 10L2 12Z"/><path d="M12 7v6M12 16v.5"/>',
  caution: '<path d="m8 2-6 6v8l6 6h8l6-6V8l-6-6Z"/><path d="M12 7v6M12 16v.5"/>',
  warning: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5M12 17v.5"/>',
  tabs: '<rect x="2" y="4" width="20" height="17" rx="2"/><path d="M2 10h20M9 4v6M16 4v6"/>',
  selector: '<circle cx="5" cy="7" r="3"/><circle cx="5" cy="17" r="3"/><path d="M12 7h10M12 17h10"/>',
  contents: '<path d="M9 6h13M9 12h13M9 18h13M2 6h2M2 12h2M2 18h2"/>',
  diagram: '<rect x="8" y="2" width="8" height="6" rx="1"/><rect x="2" y="16" width="8" height="6" rx="1"/><rect x="14" y="16" width="8" height="6" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>',
  rule: '<path d="M3 12h18"/>',
  steps: '<path d="M3 4h3v6M3 10h5M3 16c0-3 5-3 5 0l-5 5h5M12 7h10M12 18h10"/>',
  image: '<rect x="2" y="3" width="20" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m2 17 6-6 5 5 3-3 6 6"/>',
  metadata: '<path d="M7 3H3v18h4M17 3h4v18h-4M10 8h4M10 12h4M10 16h4"/>',
  include: '<path d="M3 3h11v5M3 3v15h5M10 8h11v13H10Z"/><path d="m13 12 4 3-4 3"/>',
  checklist: '<path d="m2 6 2 2 4-4M11 6h11M2 14l2 2 4-4M11 14h11M11 21h11"/>',
  nextstepaction: '<path d="M2 12h19m-7-7 7 7-7 7"/>',
  block: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 8h10M7 12h10M7 16h6"/>',
};

export function publishingIcon(kind: string): string {
  return `<svg class="publishing-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[kind] ?? paths.block}</svg>`;
}
