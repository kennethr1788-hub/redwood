import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DISPLAY_NAMES, applyDisplayNames, applyHelpDisplayNames} from '../src/display-names.js';
const template = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('Redwood naming lock renders Present without creating a new owner or route', () => {
  assert.deepEqual(DISPLAY_NAMES, {umbrella:'Redwood',short:'Redwood',build:'Build',studio:'Present',grow:'Grow',advisor:'Advisor'});
  const html = applyDisplayNames(template);
  assert.match(html, /Build\. Present\. Grow\./);
  assert.match(html, /href="#studio" data-route="studio">Present</);
  assert.match(html, /value="studio">Present</);
  assert.doesNotMatch(html, /\b(?:LaunchForge|Forge|Studio)\b/);
  assert.doesNotMatch(html, /(?:href="#present"|value="present"|products\/present)/);
  assert.equal(applyHelpDisplayNames('Redwood Present and LaunchForge Studio'), 'Redwood Present and Redwood Present');
});

test('all placeholder names are one display-only config, separate from stable IDs and paths', () => {
  assert.deepEqual(Object.keys(DISPLAY_NAMES).sort(), ['advisor','build','grow','short','studio','umbrella']);
  const changed = Object.fromEntries(Object.keys(DISPLAY_NAMES).map(key => [key, 'Renamed ' + key]));
  const html = applyDisplayNames(template, changed);
  assert.ok(!/%LABEL_/.test(html));
  for (const key of ['umbrella','build','studio','grow','advisor']) assert.ok(html.includes('Renamed ' + key));
  for (const product of ['build','studio','grow']) {
    assert.ok(html.includes(`id="${product}"`));
    assert.ok(html.includes(`href="#${product}"`));
    assert.ok(html.includes(`cd products/${product}`));
  }
  for (const value of ['IDEA','REPO','APP_OR_RECORDING','GROW_INPUTS']) assert.ok(html.includes(`value="${value}"`));
  const identity = html => [...html.matchAll(/\b(?:id|href|value|name|data-route|data-view|data-integration-slot)="([^"]+)"/g)].map(m => m[0]);
  assert.deepEqual(identity(html), identity(applyDisplayNames(template)));
  assert.equal(applyDisplayNames('%LABEL_SHORT%', changed), 'Renamed short');
});

test('labels are escaped as text, including the page title and attributes', () => {
  const names = {...DISPLAY_NAMES, umbrella: '<img src=x onerror="x"> & \'name\''};
  const html = applyDisplayNames(template, names);
  assert.ok(html.includes('&lt;img src=x onerror=&quot;x&quot;&gt; &amp; &#39;name&#39;'));
  assert.ok(!html.includes('<img src=x'));
});

test('launcher presentation has no hardcoded placeholder names outside config', async () => {
  for (const file of ['index.html','src/main.js','src/shell.js','src/advisor.js']) {
    const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    // The protocol header is a stable internal ID, not a displayed brand.
    assert.doesNotMatch(source.replaceAll('X-LaunchForge', ''), /\b(?:LaunchForge|Forge|Redwood|Build|Studio|Present|Grow|Advisor)\b/, file);
  }
});

test('source-owned help follows display config while stable identifiers remain unchanged', () => {
  const alternate = {...DISPLAY_NAMES, umbrella:'Example', build:'Make', studio:'Edit', grow:'Reach', advisor:'Helper'};
  assert.equal(applyHelpDisplayNames('LaunchForge Advisor: Build / Studio / Grow; route build and integrations/advisor', alternate),
    'Example Helper: Make / Edit / Reach; route build and integrations/advisor');
});
