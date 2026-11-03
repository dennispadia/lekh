import { CodeBlockLowlight, type CodeBlockLowlightOptions } from '@tiptap/extension-code-block-lowlight';
import { codeLanguages, editorHighlighter, findCodeLanguages, resolveCodeLanguage } from '../lib/highlight.js';
import { isMermaidLanguage } from '../lib/diagrams.js';
import { renderMermaidBlocks } from './diagrams.js';

interface LanguageCodeOptions extends CodeBlockLowlightOptions {
  copyCode: (code: string) => void;
  reportError: (message: string) => void;
}

export const LanguageCodeBlock = CodeBlockLowlight.extend<LanguageCodeOptions>({
  parseMarkdown(token, helpers) {
    if (!this.parent) throw new Error('The code-block Markdown parser is missing its base configuration.');
    // CommonMark permits up to three spaces before a fence, including inside list items.
    const indent = /^( {1,3})(?=`{3,}|~{3,})/.exec(token.raw ?? '')?.[1].length ?? 0;
    // Marked compensates for backtick indentation, but not tilde indentation.
    const text = indent && /^ {1,3}~/.test(token.raw ?? '')
      ? token.text?.split('\n').map(line => line.replace(new RegExp(`^ {0,${indent}}`), '')).join('\n')
      : token.text;
    return this.parent({ ...token, text, raw: token.raw?.slice(indent) }, helpers);
  },
  addOptions() {
    const parent = this.parent?.();
    if (!parent) throw new Error('The code-block extension is missing its base configuration.');
    return {
      ...parent,
      lowlight: editorHighlighter,
      copyCode: () => { throw new Error('Code clipboard handler is not configured.'); },
      reportError: (message: string) => { throw new Error(message); },
    };
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      let renderTimer: ReturnType<typeof setTimeout> | undefined;
      let destroyed = false;
      const dom = document.createElement('div');
      dom.className = 'code-block';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.spellcheck = false;
      pre.append(code);
      const controls = document.createElement('div');
      controls.className = 'code-block-controls';
      controls.contentEditable = 'false';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-code';
      copy.textContent = 'Copy';
      copy.setAttribute('aria-label', 'Copy code');
      copy.addEventListener('click', () => this.options.copyCode(current.textContent));
      const language = document.createElement('button');
      language.type = 'button';
      language.className = 'code-language';
      language.setAttribute('aria-label', 'Code block language');
      language.setAttribute('aria-haspopup', 'dialog');
      language.setAttribute('aria-expanded', 'false');
      const picker = document.createElement('div');
      picker.className = 'code-language-picker';
      picker.popover = 'auto';
      picker.setAttribute('role', 'dialog');
      picker.setAttribute('aria-label', 'Choose code language');
      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = 'Search languages...';
      search.setAttribute('aria-label', 'Search code languages');
      const results = document.createElement('div');
      results.className = 'code-language-results';
      results.setAttribute('role', 'listbox');
      results.setAttribute('aria-label', 'Code languages');
      picker.append(search, results);
      controls.append(copy, language, picker);
      dom.append(pre, controls);

      const updateLabel = () => {
        const raw = typeof current.attrs.language === 'string' ? current.attrs.language : '';
        const resolved = resolveCodeLanguage(raw);
        const label = codeLanguages.find(option => option.id === resolved)?.label;
        language.textContent = `${isMermaidLanguage(raw) ? 'Mermaid diagram' : label ?? `${raw} (plain text)`} \u25be`;
        language.title = label ?? 'Unsupported language label preserved; displayed as plain text.';
        const className = raw ? `language-${raw}` : '';
        if (code.className !== className) code.className = className;
        if (renderTimer) clearTimeout(renderTimer);
        if (isMermaidLanguage(raw)) {
          renderTimer = setTimeout(() => {
            if (!destroyed) void renderMermaidBlocks(dom, true);
          }, 200);
        } else {
          void renderMermaidBlocks(dom, true);
          dom.querySelector('.mermaid-preview')?.remove();
          pre.hidden = false;
        }
      };
      const closePicker = () => {
        if (picker.matches(':popover-open')) picker.hidePopover();
      };
      const chooseLanguage = (value: string) => {
        const position = getPos();
        if (typeof position !== 'number' || editor.isDestroyed) {
          this.options.reportError('This code block is no longer available.');
          return;
        }
        editor.commands.command(({ tr }) => {
          tr.setNodeMarkup(position, undefined, { ...current.attrs, language: value === 'plaintext' ? null : value });
          return true;
        });
        closePicker();
        editor.view.focus();
      };
      const renderResults = () => {
        results.replaceChildren();
        const mermaid = { id: 'mermaid', label: 'Mermaid diagram', aliases: ['diagram'] };
        const options = [...findCodeLanguages(search.value), ...(
          [mermaid.id, mermaid.label, ...mermaid.aliases].some(value => value.toLowerCase().includes(search.value.trim().toLowerCase())) ? [mermaid] : []
        )];
        for (const [index, option] of options.entries()) {
          const item = document.createElement('button');
          item.type = 'button';
          item.textContent = option.label;
          item.title = [option.id, ...option.aliases].join(', ');
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', String((isMermaidLanguage(current.attrs.language) ? 'mermaid' : resolveCodeLanguage(current.attrs.language)) === option.id));
          item.dataset.language = option.id;
          item.tabIndex = index === 0 ? 0 : -1;
          item.addEventListener('click', () => chooseLanguage(option.id));
          results.append(item);
        }
        if (!options.length) {
          const empty = document.createElement('p');
          empty.textContent = 'No supported languages match.';
          empty.setAttribute('role', 'status');
          results.append(empty);
        }
      };
      const positionPicker = () => {
        const anchor = language.getBoundingClientRect();
        const bounds = picker.getBoundingClientRect();
        picker.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8))}px`;
        const below = anchor.bottom + 6;
        picker.style.top = `${below + bounds.height <= innerHeight - 8 ? below : Math.max(8, anchor.top - bounds.height - 6)}px`;
      };
      language.addEventListener('click', () => {
        if (picker.matches(':popover-open')) { closePicker(); return; }
        search.value = '';
        renderResults();
        picker.showPopover();
        positionPicker();
        search.focus();
      });
      search.addEventListener('input', () => { renderResults(); positionPicker(); });
      picker.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closePicker();
          language.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const items = [...results.querySelectorAll<HTMLButtonElement>('button')];
          const index = items.findIndex(item => item === document.activeElement);
          const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        } else if (event.key === 'Enter' && event.target === search) {
          event.preventDefault();
          results.querySelector<HTMLButtonElement>('button')?.click();
        }
      });
      const onScroll = (event: Event) => {
        if (event.target instanceof Node && picker.contains(event.target)) return;
        positionPicker();
      };
      picker.addEventListener('toggle', () => {
        const open = picker.matches(':popover-open');
        language.setAttribute('aria-expanded', String(open));
        if (open) {
          document.addEventListener('scroll', onScroll, true);
          window.addEventListener('resize', positionPicker);
        } else {
          document.removeEventListener('scroll', onScroll, true);
          window.removeEventListener('resize', positionPicker);
        }
      });
      updateLabel();
      return {
        dom, contentDOM: code,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          updateLabel();
          return true;
        },
        stopEvent: event => event.target instanceof Node && controls.contains(event.target),
        ignoreMutation: mutation => mutation.type === 'selection'
          ? controls.contains(document.activeElement)
          : (mutation.type === 'attributes' && mutation.target === code) || !code.contains(mutation.target),
        destroy() {
          destroyed = true;
          if (renderTimer) clearTimeout(renderTimer);
          dom.querySelector('.mermaid-preview')?.remove();
          closePicker();
          document.removeEventListener('scroll', onScroll, true);
          window.removeEventListener('resize', positionPicker);
        },
      };
    };
  },
});
