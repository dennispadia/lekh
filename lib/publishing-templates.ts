export const publishingTemplates = [
  { id: 'callout-note', category: 'alerts', label: 'Note', icon: 'note', color: 'note', description: 'Add helpful context without interrupting the main instructions.', markdown: '> [!NOTE]\n> Add information readers should notice.' },
  { id: 'callout-tip', category: 'alerts', label: 'Tip', icon: 'tip', color: 'tip', description: 'Highlight a useful shortcut, suggestion, or best practice.', markdown: '> [!TIP]\n> Add a useful suggestion.' },
  { id: 'callout-important', category: 'alerts', label: 'Important', icon: 'important', color: 'important', description: 'Emphasize information readers need before continuing.', markdown: '> [!IMPORTANT]\n> Add essential information.' },
  { id: 'callout-caution', category: 'alerts', label: 'Caution', icon: 'caution', color: 'caution', description: 'Explain a risk and the precautions needed to avoid it.', markdown: '> [!CAUTION]\n> Explain a risk and how to avoid it.' },
  { id: 'callout-warning', category: 'alerts', label: 'Warning', icon: 'warning', color: 'warning', description: 'Call attention to a serious risk or potentially harmful action.', markdown: '> [!WARNING]\n> Explain a serious risk and the precautions to take.' },
  { id: 'publishing-tabs', category: 'content', label: 'Tabbed examples', icon: 'tabs', color: '', description: 'Show related examples in accessible tabs within this document.', markdown: '# [Example 1](#tab/example1)\n\n# [Example 2](#tab/example2)\n\n---' },
  { id: 'publishing-selector', category: 'content', label: 'Variant selector', icon: 'selector', color: '', description: 'Create choices, then add variant content anywhere from the Interactive menu.', markdown: ':::selector title=""\n- [Option 1](#variant/first)\n- [Option 2](#variant/second)\n:::selector-end' },
  { id: 'publishing-zone', category: 'variant', label: 'Add variant content…', icon: 'selector', color: '', description: 'Add content here for choices in the existing variant selector.', markdown: '' },
  { id: 'publishing-image', category: 'content', label: 'Image with description…', icon: 'image', color: '', description: 'Insert an image with alternate text and an optional long description.', markdown: '' },
  { id: 'publishing-metadata', category: 'content', label: 'Document metadata', icon: 'metadata', color: '', description: 'Add YAML metadata outside the article body.', markdown: '---\ntitle: Document title\ndescription: A short description of this document.\n---' },
  { id: 'publishing-include', category: 'content', label: 'Include…', icon: 'include', color: '', description: 'Show content from a local Markdown file while preserving the include directive.', markdown: '' },
] as const;

export function variantInsertionTemplate(hasSelector: boolean) {
  return publishingTemplates.find(item => item.id === (hasSelector ? 'publishing-zone' : 'publishing-selector'))!;
}

export function publishingTemplateMarkdown(id: string, selection = ''): string | undefined {
  const template = publishingTemplates.find(item => item.id === id);
  if (!template) return undefined;
  if (!selection) return template.markdown;
  if (id.startsWith('callout-')) {
    return `> [!${id.slice('callout-'.length).toUpperCase()}]\n${selection.replace(/\r\n/g, '\n').split('\n').map(line => `> ${line}`).join('\n')}`;
  }
  if (id === 'publishing-tabs') return template.markdown.replace('\n\n', () => `\n\n${selection}\n\n`);
  if (id === 'publishing-selector') return `${template.markdown}\n\n${selection}`;
  return template.markdown;
}
