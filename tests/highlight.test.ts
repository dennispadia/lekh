import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeLanguages, editorHighlighter, findCodeLanguages, highlightedHTML, highlightedSegments, resolveCodeLanguage, syntaxCSS } from '../lib/highlight.js';

test('language catalog is broad, searchable by name and aliases, and includes plain text', () => {
  assert.ok(codeLanguages.length >= 180);
  assert.equal(new Set(codeLanguages.map(language => language.id)).size, codeLanguages.length);
  assert.equal(codeLanguages[0].label, 'Plain text');
  for (const id of ['powershell', 'javascript', 'typescript', 'python', 'bash', 'json', 'yaml', 'csharp', 'cpp', 'sql', 'xml', 'css', 'rust', 'go']) {
    assert.ok(codeLanguages.some(language => language.id === id), id);
  }
  assert.ok(findCodeLanguages('.ps1').some(language => language.id === 'powershell'));
  assert.ok(findCodeLanguages('C#').some(language => language.id === 'csharp'));
  assert.equal(resolveCodeLanguage('PS1'), 'powershell');
  assert.equal(resolveCodeLanguage('js'), 'javascript');
  assert.equal(resolveCodeLanguage('html'), 'xml');
  assert.equal(resolveCodeLanguage(null), 'plaintext');
  assert.equal(resolveCodeLanguage('my-custom-language'), null);
});

test('highlighting colors selected languages without changing code, whitespace, or Unicode', () => {
  for (const [language, code] of [
    ['powershell', '$vm = "Hello"\n\n  # comment\nGet-AzVM -Name $vm\n'],
    ['js', 'const answer = 42;\n\n  console.log("Hello & <world>");\n'],
    ['python', 'def hello():\n    return "caf\u00e9 \u4f60\u597d"\n'],
    ['json', '{\n  "enabled": true,\n  "count": 42\n}\n'],
  ]) {
    const segments = highlightedSegments(code, language);
    assert.equal(segments.map(segment => segment.text).join(''), code);
    assert.ok(segments.some(segment => segment.color), language);
    assert.match(highlightedHTML(code, language), /class="hljs-/);
  }
});

test('Azure CLI has a distinct searchable fence language with shell highlighting and no alias collisions', () => {
  assert.deepEqual(codeLanguages.find(language => language.id === 'azurecli'), {
    id: 'azurecli', label: 'Azure CLI', aliases: ['azure-cli'],
  });
  for (const query of ['azurecli', 'Azure CLI', 'azure-cli']) {
    assert.ok(findCodeLanguages(query).some(language => language.id === 'azurecli'));
  }
  assert.equal(resolveCodeLanguage('AZURECLI'), 'azurecli');
  assert.equal(resolveCodeLanguage('azure-cli'), 'azurecli');
  for (const alias of ['bash', 'sh']) assert.equal(resolveCodeLanguage(alias), 'bash');
  const code = '# Example\naz vmss create --resource-group "$group" --name "demo"\n';
  assert.match(highlightedHTML(code, 'azurecli'), /hljs-comment|hljs-string/);
  assert.equal(highlightedSegments(code, 'azurecli').map(segment => segment.text).join(''), code);
  assert.deepEqual(highlightedSegments(code, 'azurecli'), highlightedSegments(code, 'bash'));
  assert.ok(editorHighlighter.highlight('azurecli', code).children.some(node => node.type === 'element'));
});

test('plain text, unlabeled, and unknown code never get guessed or lose their contents', () => {
  const code = 'const answer = "<script>alert(1)</script>";\n  # comment\n';
  for (const language of [undefined, '', 'text', 'plaintext', 'not-a-language']) {
    assert.equal(highlightedSegments(code, language).map(segment => segment.text).join(''), code);
    assert.ok(highlightedSegments(code, language).every(segment => !segment.color));
    assert.doesNotMatch(highlightedHTML(code, language), /<span/);
  }
  assert.equal(editorHighlighter.highlightAuto(code).children.length, 1);
});

test('highlighted HTML escapes code and theme palettes provide distinct readable colors', () => {
  const html = highlightedHTML('<script>alert("Hello")</script>\n& <img src=x onerror=alert(1)>', 'html');
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;/);
  assert.match(html, /&amp;/);
  assert.match(syntaxCSS('pre'), /#CF222E/);
  assert.match(syntaxCSS('pre', true), /#FF7B72/);
});
