import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeCursor, encodeCursor } from '../../src/lib/cursor.js';

test('a cursor round-trips a row', () => {
  const row = { id: '3f1b0e0e-1d2a-4a8e-9d1e-1b2c3d4e5f60', updatedAt: new Date('2026-11-11T08:00:00.123Z') };
  const decoded = decodeCursor(encodeCursor(row));
  assert.deepEqual(decoded, { updatedAt: '2026-11-11T08:00:00.123Z', id: row.id });
});

test('the cursor is opaque, not a readable timestamp', () => {
  const cursor = encodeCursor({ id: 'a', updatedAt: new Date('2026-11-11T08:00:00Z') });
  assert.ok(!cursor.includes('2026'), cursor);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
});

test('a malformed cursor decodes to null instead of throwing', () => {
  for (const bad of ['', 'not-base64!!', 'Zm9v', Buffer.from('no-separator').toString('base64url'), Buffer.from('|id').toString('base64url'), Buffer.from('2026-11-11T08:00:00Z|').toString('base64url'), Buffer.from('not-a-date|abc').toString('base64url'), null, undefined, 42]) {
    assert.equal(decodeCursor(bad), null, `expected null for ${String(bad)}`);
  }
});

test('an id containing a pipe survives the round trip', () => {
  const id = 'weird|uuid';
  const decoded = decodeCursor(encodeCursor({ id, updatedAt: new Date('2026-01-02T03:04:05Z') }));
  assert.equal(decoded.id, id);
});
