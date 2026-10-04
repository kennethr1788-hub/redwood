import test from 'node:test';
import assert from 'node:assert/strict';
import {loadLegacyFixtures} from './legacy-fixtures.mjs';
import {renderResumeMarkdown, parseResumeMarkdown, serializeResume} from '../../integrations/resume/serialization.mjs';

test('new resume heading is Redwood; exact historical resume stays readable without mutation', () => {
  const legacy = loadLegacyFixtures().find(f => f.destination === 'legacy-resume/buildCurrent.md').content.toString('utf8');
  const record = parseResumeMarkdown(legacy);
  const before = serializeResume(record);
  const current = renderResumeMarkdown(record);
  assert.match(current, /^# Redwood project resume\n/);
  assert.equal(current.replace(/^# Redwood/, '# LaunchForge'), legacy);
  assert.equal(serializeResume(parseResumeMarkdown(current)), before);
  assert.equal(serializeResume(record), before);
  assert.throws(() => parseResumeMarkdown(legacy.replace('Project:', 'Forged:')));
  assert.throws(() => parseResumeMarkdown(current.replace('Project:', 'Forged:')));
});
