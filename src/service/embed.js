/**
 * Embedding a note, and finding its neighbours. Two verbs, one file, because
 * they are the two halves of the same question.
 *
 * The text that leaves the machine is the note's own text (title, tags, body),
 * capped — nothing else, and it is the same text the person can see.
 */
export function createEmbedService({ notes, embeddings, providers, config, logger = console }) {
  function embedText(note) {
    const parts = [note.title, (note.tags || []).join(' '), note.body]
      .map((p) => String(p ?? '').trim())
      .filter(Boolean);
    return parts.join('\n').slice(0, config.embed.maxChars);
  }

  async function embed(noteId) {
    const note = await notes.get(noteId);
    if (!note) return { ok: false, reason: 'not_found' };

    const role = providers.role('embed');
    if (!role) return { ok: false, reason: 'unconfigured', gaps: providers.missing('embed') };

    let vector;
    try {
      vector = await role.embed(embedText(note));
    } catch (err) {
      logger.warn?.(`[embed] role failed for ${note.id}: ${err.message}`);
      return { ok: false, reason: 'provider_error', message: err.message };
    }

    // A model swap that changes the dimension is a configuration error worth
    // naming, not something to discover later as nonsense similarity scores.
    const expected = config.embed.dimensions;
    if (expected && vector.length !== expected) {
      return { ok: false, reason: 'dimension_mismatch', expected, got: vector.length };
    }

    const row = await embeddings.upsert({ noteId: note.id, model: role.model, vector });
    return { ok: true, noteId: note.id, model: row.model, dim: row.dim };
  }

  /**
   * Neighbours of a note. Embeds it first when it has no vector yet — asking
   * "what is this related to" should not require remembering to index first.
   * The reranker is optional: with vectors alone you get a ranked list, with
   * the `related` role you also get a reason per hit.
   */
  async function related(noteId, { limit = 5 } = {}) {
    const note = await notes.get(noteId);
    if (!note) return { ok: false, reason: 'not_found' };

    const embedRole = providers.role('embed');
    if (!embedRole) {
      return { ok: false, reason: 'unconfigured', gaps: providers.missing('embed'), role: 'embed' };
    }

    let search;
    try {
      search = await embedRole.embed(embedText(note));
    } catch (err) {
      return { ok: false, reason: 'provider_error', message: err.message, role: 'embed' };
    }

    const candidates = await embeddings.nearest({
      model: embedRole.model,
      vector: search,
      excludeNoteId: note.id,
      limit: Math.max(limit, 10),
    });

    const rerankRole = providers.role('related');
    if (!rerankRole || candidates.length === 0) {
      return { ok: true, reranked: false, items: candidates.slice(0, limit) };
    }

    try {
      const reranked = await rerankRole.rerank(note, candidates);
      return { ok: true, reranked: true, items: reranked.slice(0, limit) };
    } catch (err) {
      // A reranker that fails must not lose the vector answer underneath it.
      logger.warn?.(`[embed] rerank failed for ${note.id}: ${err.message}`);
      return { ok: true, reranked: false, rerankError: err.message, items: candidates.slice(0, limit) };
    }
  }

  return { embed, related, embedText };
}
