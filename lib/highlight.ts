import hljs, { type LanguageFn } from 'highlight.js';
import { all, createLowlight } from 'lowlight';
import { escapeHTML } from './markdown.js';

const azureCLI: LanguageFn = api => ({ ...all.bash(api), name: 'Azure CLI', aliases: ['azure-cli'] });
hljs.registerLanguage('azurecli', azureCLI);
const highlighter = createLowlight({ ...all, azurecli: azureCLI });

export const codeLanguages = highlighter.listLanguages().map(id => ({
  id,
  label: id === 'plaintext' ? 'Plain text' : hljs.getLanguage(id)?.name ?? id,
  aliases: hljs.getLanguage(id)?.aliases ?? [],
})).sort((left, right) => left.id === 'plaintext' ? -1 : right.id === 'plaintext' ? 1 : left.label.localeCompare(right.label));

const languageNames = new Map(codeLanguages.flatMap(language =>
  [language.id, ...language.aliases].map(name => [name.toLowerCase(), language.id] as const)));

export function resolveCodeLanguage(language: string | null | undefined): string | null {
  return language ? languageNames.get(language.toLowerCase()) ?? null : 'plaintext';
}

export function findCodeLanguages(query: string): typeof codeLanguages {
  const search = query.trim().toLowerCase().replace(/^\./, '');
  return codeLanguages.filter(language => [language.id, language.label, ...language.aliases]
    .some(name => name.toLowerCase().includes(search)));
}

// Unlabeled or unsupported fences remain plain text; never guess their language.
export const editorHighlighter = {
  ...highlighter,
  highlightAuto: (value: string) => highlighter.highlight('plaintext', value),
};

const syntaxColors: Record<string, readonly [string, string]> = {
  'hljs-comment': ['6A737D', '8B949E'], 'hljs-quote': ['6A737D', '8B949E'],
  'hljs-keyword': ['CF222E', 'FF7B72'], 'hljs-doctag': ['CF222E', 'FF7B72'],
  'hljs-selector-tag': ['CF222E', 'FF7B72'], 'hljs-literal': ['0550AE', '79C0FF'],
  'hljs-string': ['0A3069', 'A5D6FF'], 'hljs-regexp': ['0A3069', 'A5D6FF'],
  'hljs-number': ['0550AE', '79C0FF'], 'hljs-variable': ['0550AE', '79C0FF'],
  'hljs-template-variable': ['0550AE', '79C0FF'], 'hljs-attr': ['0550AE', '79C0FF'],
  'hljs-attribute': ['0550AE', '79C0FF'], 'hljs-built_in': ['0550AE', '79C0FF'],
  'hljs-symbol': ['0550AE', '79C0FF'], 'hljs-bullet': ['0550AE', '79C0FF'],
  'hljs-title': ['8250DF', 'D2A8FF'], 'hljs-section': ['8250DF', 'D2A8FF'],
  'hljs-type': ['953800', 'FFA657'], 'hljs-meta': ['953800', 'FFA657'],
  'hljs-selector-class': ['116329', '7EE787'], 'hljs-selector-id': ['116329', '7EE787'],
  'hljs-addition': ['116329', '7EE787'], 'hljs-deletion': ['82071E', 'FFDCD7'],
};

export function syntaxCSS(scope: string, dark = false): string {
  return Object.entries(syntaxColors).map(([name, colors]) => `${scope} .${name}{color:#${colors[dark ? 1 : 0]}}`).join('\n');
}

type HighlightNode = ReturnType<typeof highlighter.highlight>['children'][number];

function nodeClasses(node: Extract<HighlightNode, { type: 'element' }>): string[] {
  const names = node.properties.className;
  return names?.map(String) ?? [];
}

function highlightTree(code: string, language?: string | null) {
  return highlighter.highlight(resolveCodeLanguage(language) ?? 'plaintext', code);
}

export function highlightedHTML(code: string, language?: string | null): string {
  const render = (node: HighlightNode): string => {
    if (node.type === 'text') return escapeHTML(node.value);
    if (node.type !== 'element') return '';
    const classes = nodeClasses(node).filter(name => /^[\w-]+$/.test(name));
    return `<span class="${classes.join(' ')}">${node.children.map(render).join('')}</span>`;
  };
  return highlightTree(code, language).children.map(render).join('');
}

export interface CodeSegment { text: string; color?: string }

export function highlightedSegments(code: string, language?: string | null): CodeSegment[] {
  const segments: CodeSegment[] = [];
  const visit = (node: HighlightNode, inherited: string[] = []): void => {
    if (node.type === 'element') {
      const classes = [...inherited, ...nodeClasses(node)];
      node.children.forEach(child => visit(child, classes));
    } else if (node.type === 'text') {
      const kind = [...inherited].reverse().find(name => Object.hasOwn(syntaxColors, name));
      const color = kind ? syntaxColors[kind][0] : undefined;
      const previous = segments.at(-1);
      if (previous && previous.color === color) previous.text += node.value;
      else segments.push({ text: node.value, color });
    }
  };
  highlightTree(code, language).children.forEach(node => visit(node));
  return segments;
}
