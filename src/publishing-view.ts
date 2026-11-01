import { documentPreviewHTML, headingAnchor, headings } from '../lib/markdown.js';
import { codeLanguages, highlightedHTML, resolveCodeLanguage } from '../lib/highlight.js';

let nextGroup = 0;
const selectedVariants = new Map<string, string>();

export function choosePublishingVariant(pane: HTMLElement, id: string): void {
  if (!pane.dataset.documentId) return;
  selectedVariants.set(pane.dataset.documentId, id);
  refreshPublishingVariants(pane);
}

export async function publishingHTML(markdown: string, documentId: string): Promise<string> {
  if (/^zone_pivot_groups\s*:/m.test(markdown) && documentId) {
    const result = await window.lekh.prepareVariantConfiguration(documentId, markdown);
    if (!result.ok) throw new Error(result.error);
    markdown = result.value;
  }
  const template = document.createElement('template');
  template.innerHTML = documentPreviewHTML(markdown, documentId);
  const outline = headings(markdown);
  const used = new Map<string, number>();
  template.content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach((heading, index) => {
    if (outline[index]) heading.id = headingAnchor(outline[index].text, used);
  });
  return template.innerHTML;
}

export function initializePublishing(root: HTMLElement, reportError?: (message: string) => void): void {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
    if (code.closest('.publishing-code') || code.classList.contains('language-mermaid')) continue;
    const pre = code.parentElement!;
    const language = [...code.classList].find(name => name.startsWith('language-'))?.slice('language-'.length);
    const text = code.textContent ?? '';
    code.innerHTML = highlightedHTML(text, language);
    const wrapper = document.createElement('div');
    wrapper.className = 'publishing-code';
    const header = document.createElement('div');
    header.className = 'publishing-code-header';
    const label = document.createElement('span');
    label.textContent = codeLanguages.find(item => item.id === resolveCodeLanguage(language))?.label ?? 'Plain text';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'publishing-copy-code';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy code');
    copy.addEventListener('click', () => {
      void window.lekh.writeClipboard(text).then(result => {
        if (!result.ok) throw new Error(result.error);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
      }).catch(error => {
        const message = `Code could not be copied: ${String(error)}`;
        copy.textContent = 'Copy failed';
        copy.title = message;
        console.error(message);
        reportError?.(message);
      });
    });
    header.append(label, copy);
    pre.before(wrapper);
    wrapper.append(header, pre);
  }
  for (const group of root.querySelectorAll<HTMLElement>('[data-publishing-tabs]')) {
    if (group.dataset.publishingReady) continue;
    group.dataset.publishingReady = 'true';
    const tabs = [...group.querySelectorAll<HTMLButtonElement>('[data-publishing-tab]')]
      .filter(tab => tab.closest('[data-publishing-tabs]') === group);
    const panels = [...group.querySelectorAll<HTMLElement>('[data-publishing-panel]')]
      .filter(panel => panel.closest('[data-publishing-tabs]') === group);
    const id = `publishing-tabs-${++nextGroup}`;
    const select = (index: number, focus = false) => {
      tabs.forEach((tab, current) => {
        tab.id = `${id}-tab-${current}`;
        tab.setAttribute('aria-controls', `${id}-panel-${current}`);
        tab.setAttribute('aria-selected', String(current === index));
        tab.tabIndex = current === index ? 0 : -1;
      });
      panels.forEach((panel, current) => {
        panel.id = `${id}-panel-${current}`;
        panel.setAttribute('aria-labelledby', `${id}-tab-${current}`);
        panel.hidden = current !== index;
      });
      if (focus) tabs[index]?.focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', event => { event.preventDefault(); select(index); });
      tab.addEventListener('keydown', event => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : event.key === 'ArrowRight' ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
        if (next !== null) { event.preventDefault(); event.stopPropagation(); select(next, true); }
      });
    });
    select(0);
  }
  const pane = root.closest<HTMLElement>('.document-pane');
  if (pane) refreshPublishingVariants(pane);
}

export function refreshPublishingVariants(pane: HTMLElement): void {
  const documentId = pane.dataset.documentId;
  if (!documentId) return;
  pane.querySelector(':scope > .publishing-document-selector')?.remove();
  const surfaces = [
    pane.querySelector<HTMLElement>('.visual-surface'),
    pane.querySelector<HTMLElement>('.document-preview'),
  ].filter((surface): surface is HTMLElement => surface !== null);
  const primary = surfaces.find(surface => !surface.closest('[hidden]') && surface.querySelector('[data-publishing-zone], [data-publishing-selector]:not(.publishing-document-selector)'))
    ?? surfaces.find(surface => surface.querySelector('[data-publishing-zone], [data-publishing-selector]:not(.publishing-document-selector)'));
  const zones = [...pane.querySelectorAll<HTMLElement>('[data-publishing-zone]')];
  const selectors = [...pane.querySelectorAll<HTMLElement>('[data-publishing-selector]')]
    .filter(element => !element.classList.contains('publishing-document-selector'));
  const choices = new Map<string, string>();
  for (const selector of selectors.filter(element => primary?.contains(element))) {
    for (const control of selector.querySelectorAll<HTMLElement>('[data-publishing-variant]')) {
      const id = control.dataset.publishingVariant;
      if (id) choices.set(id, control.textContent?.trim() || id);
    }
  }
  for (const zone of zones.filter(element => primary?.contains(element))) {
    for (const id of (zone.dataset.publishingZone ?? '').split(',').map(value => value.trim()).filter(Boolean)) {
      if (!choices.has(id)) choices.set(id, id.replace(/[-_]/g, ' '));
    }
  }
  for (const selector of selectors) {
    for (const control of selector.querySelectorAll<HTMLElement>('[data-publishing-variant]')) {
      control.dataset.publishingChoice = control.dataset.publishingVariant;
      if (control.dataset.publishingChoiceReady) continue;
      control.dataset.publishingChoiceReady = 'true';
      control.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        selectedVariants.set(documentId, control.dataset.publishingVariant!);
        refreshPublishingVariants(pane);
      });
    }
  }
  for (const surface of surfaces) {
    let bar = surface.querySelector<HTMLElement>(':scope > .publishing-document-selector');
    const explicit = selectors.some(selector => surface.contains(selector));
    if (!choices.size || explicit || !surface.querySelector('[data-publishing-zone]')) { bar?.remove(); continue; }
    const signature = JSON.stringify([...choices]);
    if (!bar || bar.dataset.signature !== signature) {
      bar?.remove();
      bar = document.createElement('section');
      bar.className = 'publishing-document-selector publishing-selector';
      bar.dataset.publishingSelector = 'document';
      bar.dataset.signature = signature;
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', 'Choose a variant');
      bar.title = 'Selection changes rendered content only. Source and interactive HTML export keep every alternative.';
      const heading = document.createElement('strong');
      heading.textContent = 'Choose a variant';
      const controls = document.createElement('div');
      controls.className = 'publishing-variant-options';
      for (const [id, label] of choices) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.dataset.publishingChoice = id;
        button.addEventListener('click', () => {
          selectedVariants.set(documentId, id);
          refreshPublishingVariants(pane);
        });
        controls.append(button);
      }
      bar.append(heading, controls);
      const note = document.createElement('small');
      note.textContent = 'Using variant IDs. Allow the local project folder to load available publishing labels.';
      bar.append(note);
      surface.prepend(bar);
    }
  }
  if (!choices.size) return;
  let selected = selectedVariants.get(documentId);
  if (!selected || !choices.has(selected)) {
    selected = choices.keys().next().value!;
    selectedVariants.set(documentId, selected);
  }
  pane.dataset.variantSelection = selected;
  for (const button of pane.querySelectorAll<HTMLElement>('[data-publishing-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.publishingChoice === selected));
  }
  for (const selector of selectors) {
    const status = selector.querySelector<HTMLElement>(':scope > .publishing-selection-status');
    if (status) status.textContent = `Showing: ${choices.get(selected) ?? selected}`;
  }
  for (const zone of zones) {
    const visible = (zone.dataset.publishingZone ?? '').split(',').some(value => value.trim() === selected);
    if (zone.dataset.lekhEditableZone === 'true') {
      zone.hidden = false;
      zone.classList.toggle('publishing-zone-inactive', !visible);
      const content = zone.querySelector<HTMLElement>(':scope > .publishing-editable-body');
      if (content) content.hidden = !visible;
      const status = zone.querySelector<HTMLElement>('.publishing-zone-status');
      if (status) status.textContent = visible ? 'Showing' : 'Not selected';
      const show = zone.querySelector<HTMLButtonElement>(':scope > .publishing-edit-header button');
      if (show) show.hidden = visible;
    } else zone.hidden = !visible;
  }
  for (const block of pane.querySelectorAll<HTMLElement>('[data-publishing-zone-block]')) {
    const children = [...block.querySelectorAll<HTMLElement>('[data-publishing-zone]')];
    const collapsed = children.length > 0 && children.every(zone => zone.hidden);
    let placeholder = block.querySelector<HTMLElement>(':scope > .publishing-variant-placeholder');
    if (collapsed && !placeholder) {
      placeholder = document.createElement('div');
      placeholder.className = 'publishing-variant-placeholder';
      block.append(placeholder);
    }
    if (placeholder) {
      placeholder.hidden = !collapsed;
      placeholder.textContent = `Other variant content is preserved here: ${children.map(zone => zone.dataset.publishingZone).join(', ')}. Use Edit source to change it.`;
    }
  }
}

export function forgetPublishingDocument(id: string): void { selectedVariants.delete(id); }

export function revealPublishingElement(element: HTMLElement): void {
  const pane = element.closest<HTMLElement>('.document-pane');
  const zone = element.closest<HTMLElement>('[data-publishing-zone]');
  if (pane?.dataset.documentId && zone) {
    const first = zone.dataset.publishingZone?.split(',')[0].trim();
    if (first) { selectedVariants.set(pane.dataset.documentId, first); refreshPublishingVariants(pane); }
  }
  let current: HTMLElement | null = element;
  while (current) {
    const panel: HTMLElement | null = current.closest('[data-publishing-panel]');
    if (!panel) break;
    const group: HTMLElement | null = panel.closest('[data-publishing-tabs]');
    const control = group ? [...group.querySelectorAll<HTMLButtonElement>('[data-publishing-tab]')]
      .find(button => button.closest('[data-publishing-tabs]') === group && button.dataset.publishingTab === panel.dataset.publishingPanel) : undefined;
    control?.click();
    current = group?.parentElement ?? null;
  }
}
