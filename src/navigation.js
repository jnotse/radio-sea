// Navigation suggestions: the crowd-curated "from this record, go to that one"
// graph (zig-zag: POST/GET/DELETE /v2/maps/:mapId/navigation-suggestions).

let nextId = 1;

export class NavigationGraph {
  constructor() {
    this.edges = new Map(); // id -> { id, fromReleaseId, toReleaseId, toTrackId }
  }

  add({ fromReleaseId, toReleaseId, toTrackId = null }) {
    if (fromReleaseId === toReleaseId) {
      throw new Error('navigation suggestion cannot point at the same release');
    }
    for (const edge of this.edges.values()) {
      if (edge.fromReleaseId === fromReleaseId && edge.toReleaseId === toReleaseId) {
        throw new Error('navigation suggestion already exists');
      }
    }
    const id = nextId++;
    this.edges.set(id, { id, fromReleaseId, toReleaseId, toTrackId });
    return id;
  }

  /**
   * Mirrors GET ...?from_release_id&limit. fromReleaseId = 0 returns general
   * suggestions (not tied to a specific release), like the site.
   */
  list({ fromReleaseId = 0, limit = 10 } = {}) {
    const rows = [...this.edges.values()]
      .filter((e) => (fromReleaseId === 0 ? true : e.fromReleaseId === fromReleaseId))
      .sort((a, b) => a.id - b.id);
    return rows.slice(0, limit);
  }

  remove(id) {
    return this.edges.delete(id);
  }
}
