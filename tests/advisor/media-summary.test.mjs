import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mediaSummary} from '../../launcher/src/advisor.js';
import {supportDoctor} from '../../integrations/connectors/support-doctor.mjs';
import {readLocalObservations, recordLocalObservation} from '../../integrations/connectors/local-observations.mjs';

test('media summary follows scoped observation from current through real registry expiry', () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'redwood-advisor-summary-')));
  const now = '2026-10-04T18:00:00.000Z';
  try {
    assert.match(mediaSummary(supportDoctor(now)), /Account capability has not been checked/);
    recordLocalObservation(directory, {connectorId:'higgsfield',mode:'AGENT_ACCOUNT',detected:true,
      authenticated:true,billingMode:'ACCOUNT_CREDITS',verifiedCapabilities:['VIDEO_GENERATION'],
      evidenceDigest:'a'.repeat(64),label:'synthetic selected model and local scope',now,ttlMs:1000});
    const observations = readLocalObservations(directory);
    const current = mediaSummary(supportDoctor(now, observations));
    assert.match(current, /checked for the recorded scope/);
    assert.match(current, /AGENT_ACCOUNT; synthetic selected model and local scope/);
    assert.match(current, /checked 2026-10-04T18:00:00.000Z/);
    assert.doesNotMatch(current, /has not been checked/);
    const stale = supportDoctor('2026-10-04T18:00:02.000Z', observations);
    assert.equal(stale.rows.find(row => row.connectorId === 'higgsfield').freshness, 'STALE_OR_UNBOUND');
    assert.match(mediaSummary(stale), /Prior capability checks are stale or unbound/);
    assert.doesNotMatch(mediaSummary(stale), /has not been checked|checked for the recorded scope/);
  } finally { rmSync(directory, {recursive:true,force:true}); }
});
