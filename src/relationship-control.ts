let selection: { id: string; source: string | null } | null = null;
export function selectRelationshipControl(value: typeof selection): void {
  selection = value;
  window.dispatchEvent(new Event('lekh-relationship-selection'));
}
export function relationshipControl(id: string, source: () => string): { dom: HTMLLabelElement; refresh: () => void; destroy: () => void } {
  const dom = document.createElement('label');
  dom.className = 'include-relationship-control';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('aria-controls', 'relationships-panel');
  dom.append(input, document.createTextNode('Show relationships'));
  const refresh = () => { input.checked = selection?.id === id && selection.source === source(); };
  input.addEventListener('change', () => {
    window.dispatchEvent(new CustomEvent('lekh-show-relationships', { detail: { id, source: source(), open: input.checked } }));
  });
  window.addEventListener('lekh-relationship-selection', refresh);
  refresh();
  return { dom, refresh, destroy: () => window.removeEventListener('lekh-relationship-selection', refresh) };
}
