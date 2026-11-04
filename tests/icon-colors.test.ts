import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { iconTone } from '../lib/icon-colors.js';
import { publishingIcon } from '../lib/publishing-icons.js';

test('shared icon categories match toolbar and publishing/context-menu symbols', () => {
  assert.equal(iconTone('bold'), 'format');
  assert.equal(iconTone('image'), 'insert');
  assert.equal(iconTone('learn'), 'review');
  assert.equal(iconTone('chevron'), 'navigation');
  assert.equal(iconTone('delete'), 'caution');
  for (const kind of ['note', 'tip', 'important', 'caution', 'warning']) {
    assert.equal(iconTone(kind), kind);
    assert.match(publishingIcon(kind), new RegExp(`data-icon-tone="${kind}"`));
    assert.match(publishingIcon(kind), /aria-hidden="true"/);
  }
});

test('every light and dark icon color meets 3:1 contrast on app surfaces', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const blocks = [css.match(/:root \{([\s\S]*?)\}/)![1], css.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\}/)![1]];
  const luminance = (hex: string) => {
    const rgb = hex.match(/\w\w/g)!.map(value => parseInt(value, 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  for (const block of blocks) {
    const tokens = new Map([...block.matchAll(/--([\w-]+):\s*#([\da-f]{6})/g)].map(match => [match[1], luminance(match[2])]));
    for (const [name, value] of tokens) {
      if (!name.startsWith('icon-')) continue;
      for (const surface of ['bg', 'panel', 'paper', 'soft', 'hover', 'selection']) {
        const background = tokens.get(surface)!;
        const contrast = (Math.max(value, background) + .05) / (Math.min(value, background) + .05);
        assert.ok(contrast >= 3, `${name} contrast on ${surface}: ${contrast.toFixed(2)}`);
      }
    }
  }
});
