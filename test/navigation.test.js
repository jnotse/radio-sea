import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NavigationGraph } from '../src/navigation.js';

test('add / list / remove round trip', () => {
  const graph = new NavigationGraph();
  const id = graph.add({ fromReleaseId: 'rel-1', toReleaseId: 'rel-2', toTrackId: 'rel-2-t1' });
  assert.ok(id > 0);

  const rows = graph.list({ fromReleaseId: 'rel-1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toReleaseId, 'rel-2');
  assert.equal(rows[0].toTrackId, 'rel-2-t1');

  assert.ok(graph.remove(id));
  assert.equal(graph.list({ fromReleaseId: 'rel-1' }).length, 0);
});

test('from_release_id = 0 lists general suggestions', () => {
  const graph = new NavigationGraph();
  graph.add({ fromReleaseId: 'a', toReleaseId: 'b' });
  graph.add({ fromReleaseId: 'c', toReleaseId: 'd' });
  assert.equal(graph.list({ fromReleaseId: 0 }).length, 2);
  assert.equal(graph.list({ fromReleaseId: 'a' }).length, 1);
});

test('duplicates and self-loops are rejected', () => {
  const graph = new NavigationGraph();
  graph.add({ fromReleaseId: 'a', toReleaseId: 'b' });
  assert.throws(() => graph.add({ fromReleaseId: 'a', toReleaseId: 'b' }), /already exists/);
  assert.throws(() => graph.add({ fromReleaseId: 'a', toReleaseId: 'a' }), /same release/);
});

test('limit truncates results', () => {
  const graph = new NavigationGraph();
  for (let i = 0; i < 5; i += 1) graph.add({ fromReleaseId: 'a', toReleaseId: `t${i}` });
  assert.equal(graph.list({ fromReleaseId: 'a', limit: 2 }).length, 2);
});
