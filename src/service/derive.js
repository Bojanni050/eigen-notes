/**
 * The one flow that touches a model in this slice: ask the `summary` role for
 * tags and a sentence, and write the answer to the derived side.
 *
 * It never writes to `notes`. It never invents output when the role is absent
 * or the model misbehaves — it reports why, and the caller turns that into an
 * HTTP status that says the same thing.
 */
export function createDeriveService({
  notes,
  derived,
  providers,
  config,
  logger = console,
}) {
  return async function derive(noteId) {
    const note = await notes.get(noteId);
    if (!note) return { ok: false, reason: 'not_found' };

    const role = providers.role('summary');
    if (!role) {
      return { ok: false, reason: 'unconfigured', gaps: providers.missing('summary') };
    }

    let suggestion;
    try {
      suggestion = await role.summarize(note, { maxChars: config.summaryMaxChars });
    } catch (err) {
      logger.warn?.(`[derive] summary role failed for ${note.id}: ${err.message}`);
      return { ok: false, reason: 'provider_error', message: err.message };
    }

    const items = [];
    const lineage = { provider: role.baseUrl, model: role.model };

    if (suggestion.tags.length > 0) {
      items.push(await derived.insert({
        noteId: note.id,
        kind: 'tag_suggestion',
        payload: { tags: suggestion.tags },
        ...lineage,
      }));
    }
    if (suggestion.summary) {
      items.push(await derived.insert({
        noteId: note.id,
        kind: 'summary',
        payload: { summary: suggestion.summary },
        ...lineage,
      }));
    }

    if (items.length === 0) return { ok: false, reason: 'empty_suggestion' };
    return { ok: true, noteId: note.id, items };
  };
}
