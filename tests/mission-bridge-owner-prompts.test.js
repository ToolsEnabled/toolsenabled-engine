'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ownerPrompts = require('../src/lib/mission-bridge/owner-prompts.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-bridge-owner-prompts-'));
const dependencies = {
  stateFile: path.join(root, 'owner-prompts.json'),
  clock: () => Date.parse('2026-08-27T12:00:00.000Z')
};

try {
  const attributedIds = ['R241', 'R52.1'];
  const enqueued = ownerPrompts.enqueue({
    kind: 'purchase_batch',
    title: 'Review purchase',
    message: 'Approve or deny each item.',
    ttlMs: null,
    items: [
      {
        id: 'attributed-item',
        description: 'Annual service plan',
        amountCents: 2500,
        currency: 'USD',
        merchant: 'Example Merchant',
        purpose: 'Operate the service',
        ownerRequestIds: attributedIds
      },
      {
        id: 'agent-item',
        description: 'Optional support plan',
        amountCents: 500,
        currency: 'USD',
        merchant: 'Example Merchant',
        purpose: 'Agent-proposed support'
      }
    ]
  }, dependencies);

  assert.equal(enqueued.itemCount, 2);
  assert.equal(enqueued.totalCents, 3000);

  const snapshot = ownerPrompts.snapshot(dependencies);
  assert.equal(snapshot.prompts.length, 1);
  const [attributed, agentProposed] = snapshot.prompts[0].items;

  assert.equal(
    attributed.description,
    `${ownerPrompts.provenanceStamp(attributedIds)}Annual service plan`,
    'the owner-visible item must identify the owner requests that authorized it'
  );
  assert.equal(
    agentProposed.description,
    `${ownerPrompts.UNPROVENANCED_STAMP}Optional support plan`,
    'an item without owner-request provenance must be visibly labelled agent-proposed'
  );
  assert.equal('ownerRequestIds' in attributed, false, 'internal provenance must not change the public wire shape');
  assert.deepEqual(
    Object.keys(attributed).sort(),
    ['amountCents', 'currency', 'description', 'id', 'merchant', 'purpose'].sort()
  );

  console.log('mission-bridge-owner-prompts: provenance is visible without changing the wire shape');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
