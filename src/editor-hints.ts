import { Extension } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export function emptyEditorHints(doc: Node, focusedPosition?: number): DecorationSet {
  const hints: Decoration[] = [];
  doc.descendants((node, position, parent) => {
    if (node.type.name !== 'paragraph' || node.content.size || parent?.childCount !== 1) return;
    if (focusedPosition !== undefined && focusedPosition > position && focusedPosition < position + node.nodeSize) return;
    const text = parent === doc ? 'Start writing, or press / for commands. Right-click for more tools.'
      : parent?.type.name === 'lekhTab' ? 'Write this example here. Select text to format it.'
      : parent?.type.name === 'lekhZone' ? 'Write content for the selected options here.'
      : undefined;
    if (text) hints.push(Decoration.node(position, position + node.nodeSize, {
      class: 'editor-empty-hint', 'data-placeholder': text,
    }, { placeholder: text }));
  });
  return DecorationSet.create(doc, hints);
}

export const EditorHints = Extension.create({
  name: 'editorHints',
  addProseMirrorPlugins() {
    const key = new PluginKey<boolean>('editorHintsFocus');
    return [new Plugin({
      key,
      state: { init: () => false, apply: (tr, focused) => tr.getMeta(key) ?? focused },
      props: {
        decorations: state => emptyEditorHints(state.doc, key.getState(state) ? state.selection.from : undefined),
        handleDOMEvents: {
          focus: view => { view.dispatch(view.state.tr.setMeta(key, true).setMeta('addToHistory', false)); return false; },
          blur: view => { view.dispatch(view.state.tr.setMeta(key, false).setMeta('addToHistory', false)); return false; },
        },
      },
    })];
  },
});
