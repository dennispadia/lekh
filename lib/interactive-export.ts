import { syntaxCSS } from './highlight.js';
import { publishingCSS } from './publishing.js';

export const interactiveExportCSS = `
  :root { color-scheme: light; font-family: "Segoe UI", Arial, sans-serif; color: #242424; background: #fff; }
  * { box-sizing: border-box; }
  body { max-width: 960px; margin: 0 auto; padding: 2rem clamp(1rem, 4vw, 3rem) 4rem; line-height: 1.65; overflow-wrap: break-word; }
  h1,h2,h3,h4,h5,h6 { line-height: 1.3; margin-top: 1.5em; }
  h1 { font-size: 2.2rem; margin-top: 0; }
  a { color: #115ea3; }
  img { max-width: 100%; height: auto; }
  pre { background: #f5f5f5; border: 1px solid #ddd; border-radius: 6px; padding: 1rem; overflow-x: auto; }
  code { font-family: Consolas, monospace; }
  :not(pre) > code { background: #f5f5f5; padding: .1em .25em; border-radius: 3px; }
  blockquote { border-left: 3px solid #aeb9bd; padding-left: 1rem; margin-left: 0; }
  table { width: 100%; border-collapse: collapse; display: block; overflow-x: auto; }
  th,td { border: 1px solid #d5d9dc; padding: .5rem .75rem; }
  th { background: #f3f5f6; }
  li.task-item { list-style: none; position: relative; }
  .task-checkbox { position: absolute; left: -1.5em; }
  ${publishingCSS}
  .publishing-tablist,.publishing-variant-options { display: none; }
  .publishing-tab-label { display: block; }
  html[data-lekh-interactive] .publishing-tablist,html[data-lekh-interactive] .publishing-variant-options { display: flex; }
  html[data-lekh-interactive] .publishing-tab-label { display: none; }
  .offline-notice { padding: .75rem 1rem; border: 1px solid #d1d1d1; background: #f5f5f5; }
  @media print {
    html[data-lekh-interactive] .publishing-tab-panel[hidden],html[data-lekh-interactive] .publishing-zone[hidden] { display: none !important; }
    html[data-lekh-interactive] .publishing-tab-label { display: block; }
  }
  ${syntaxCSS('pre')}
`;

// This fixed script never incorporates document text; untrusted labels are read from the DOM.
export const interactiveExportScript = String.raw`(() => {
  const tabGroups = new Map();
  for (const group of document.querySelectorAll('[data-publishing-tabs]')) {
    const tabs = Array.from(group.querySelectorAll('[data-publishing-tab]'))
      .filter(tab => tab.closest('[data-publishing-tabs]') === group);
    const panels = Array.from(group.querySelectorAll('[data-publishing-panel]'))
      .filter(panel => panel.closest('[data-publishing-tabs]') === group);
    const select = (index, focus = false) => {
      tabs.forEach((tab, current) => {
        tab.setAttribute('aria-selected', String(current === index));
        tab.tabIndex = current === index ? 0 : -1;
      });
      panels.forEach((panel, current) => { panel.hidden = current !== index; });
      if (focus) tabs[index].focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => select(index));
      tab.addEventListener('keydown', event => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : event.key === 'ArrowRight' ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
        if (next !== null) { event.preventDefault(); event.stopPropagation(); select(next, true); }
      });
    });
    tabGroups.set(group, { panels, select });
    if (tabs.length) select(0);
  }

  const zones = Array.from(document.querySelectorAll('[data-publishing-zone]'));
  const controls = Array.from(document.querySelectorAll('[data-publishing-variant]'));
  const choices = new Map();
  const reachable = new Set();
  for (const control of controls) {
    const id = control.dataset.publishingVariant;
    if (!choices.has(id)) choices.set(id, control.textContent.trim() || id);
    if (!control.closest('[data-publishing-zone], [data-publishing-panel]')) reachable.add(id);
  }
  for (const zone of zones) {
    for (const id of zone.dataset.publishingZone.split(',').map(value => value.trim()).filter(Boolean)) {
      if (!choices.has(id)) choices.set(id, id.replace(/[-_]+/g, ' '));
    }
  }
  const missing = Array.from(choices).filter(([id]) => !reachable.has(id));
  if (missing.length) {
    const selector = document.createElement('section');
    selector.className = 'publishing-selector';
    selector.dataset.publishingSelector = 'fallback';
    selector.setAttribute('aria-label', 'Choose a variant');
    const title = document.createElement('p');
    title.className = 'publishing-selector-title';
    title.textContent = reachable.size ? 'Additional variants' : 'Choose a variant';
    const options = document.createElement('div');
    options.className = 'publishing-variant-options';
    options.setAttribute('role', 'group');
    options.setAttribute('aria-label', title.textContent);
    for (const [id, label] of missing) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.publishingVariant = id;
      button.textContent = label;
      options.append(button);
      controls.push(button);
    }
    selector.append(title, options);
    const heading = document.querySelector('body > h1');
    if (heading) heading.after(selector);
    else document.body.prepend(selector);
  }
  const selectVariant = selected => {
    controls.forEach(control => control.setAttribute('aria-pressed', String(control.dataset.publishingVariant === selected)));
    zones.forEach(zone => {
      zone.hidden = !zone.dataset.publishingZone.split(',').some(value => value.trim() === selected);
    });
    if (document.activeElement?.closest('[data-publishing-zone][hidden], [data-publishing-panel][hidden]')) {
      controls.find(control => control.dataset.publishingVariant === selected &&
        !control.closest('[data-publishing-zone][hidden], [data-publishing-panel][hidden]'))?.focus();
    }
  };
  controls.forEach(control => control.addEventListener('click', () => selectVariant(control.dataset.publishingVariant)));
  if (controls.length) selectVariant(controls[0].dataset.publishingVariant);
  const revealFragment = hash => {
    let id;
    try { id = decodeURIComponent(hash.slice(1)); } catch { return; }
    if (!id) return;
    const target = document.getElementById(id) || document.getElementsByName(id)[0];
    if (!target) return;
    const ancestors = [];
    for (let element = target; element; element = element.parentElement) {
      if (element.matches('[data-publishing-zone]')) ancestors.push(element);
      if (element.matches('[data-publishing-panel]')) {
        const group = tabGroups.get(element.closest('[data-publishing-tabs]'));
        const index = group?.panels.indexOf(element) ?? -1;
        if (index >= 0) group.select(index);
      }
    }
    if (ancestors.length) {
      const options = ancestors.map(zone => zone.dataset.publishingZone.split(',').map(value => value.trim()).filter(Boolean));
      const compatible = options[0].filter(value => options.every(ids => ids.includes(value)));
      const selected = controls.find(control => control.getAttribute('aria-pressed') === 'true')?.dataset.publishingVariant;
      const variant = compatible.includes(selected) ? selected : compatible[0] || options[0][0];
      if (variant) selectVariant(variant);
      // An explicit fragment can target nested zones with no common variant.
      ancestors.forEach(zone => { zone.hidden = false; });
    }
    target.scrollIntoView();
  };
  window.addEventListener('hashchange', () => revealFragment(window.location.hash));
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href, window.location.href);
    if (url.hash && url.hash === window.location.hash && url.href.split('#')[0] === window.location.href.split('#')[0]) {
      event.preventDefault();
      revealFragment(url.hash);
    }
  });
  document.documentElement.dataset.lekhInteractive = 'true';
  revealFragment(window.location.hash);
})();`;
