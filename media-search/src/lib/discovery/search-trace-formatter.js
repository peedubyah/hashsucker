/**
 * Search Trace Formatter
 *
 * Renders a search trace as terminal text.
 * No cards. No dashboards. Plain text.
 *
 * Format:
 *   SEARCH TRACE
 *
 *   Sources:
 *   ✓ DMM corpus: 120 candidates
 *   ✓ Torrentio: 40 candidates
 *   ✓ Comet: 30 candidates
 *
 *   Winner:
 *   Hash123
 *
 *   Why:
 *   +20 cached
 *   +10 stored corpus
 *   +5 2160p
 *   -2 metadata unknown
 *
 *   Rejected:
 *   Hash456
 *   Reason: duplicate
 */

/**
 * Format a search trace as plain terminal text.
 *
 * @param {Object} trace - Output from searchTrace()
 * @returns {string} Formatted text
 */
export function formatSearchTrace(trace) {
  const lines = [];

  lines.push('SEARCH TRACE');
  lines.push('');

  // Sources
  lines.push('Sources:');
  const corpusCount = trace.sources.corpus?.count ?? 0;
  lines.push(`  ✓ DMM corpus: ${corpusCount} candidates`);

  if (trace.sources.live && trace.sources.live.queried !== false) {
    const torrentio = trace.sources.live.torrentio ?? 0;
    const torznab = trace.sources.live.torznab ?? 0;
    if (torrentio > 0 || trace.sources.live.errors?.torrentio) {
      const error = trace.sources.live.errors?.torrentio;
      lines.push(`  ${error ? '✗' : '✓'} Torrentio: ${torrentio} candidates${error ? ` (${error})` : ''}`);
    }
    if (torznab > 0 || trace.sources.live.errors?.torznab) {
      const error = trace.sources.live.errors?.torznab;
      lines.push(`  ${error ? '✗' : '✓'} Comet: ${torznab} candidates${error ? ` (${error})` : ''}`);
    }
  }

  // Pipeline summary
  lines.push('');
  lines.push(`Pipeline: ${trace.pipeline.discovered} discovered → ${trace.pipeline.deduped} deduped → ${trace.pipeline.ranked} ranked → ${trace.pipeline.returned} returned`);

  // Winner
  const winner = trace.candidates[0];
  if (winner) {
    lines.push('');
    lines.push('Winner:');
    lines.push(`  ${winner.hash}`);

    // Why
    if (winner.justification) {
      lines.push('');
      lines.push('Why:');
      const j = winner.justification;
      const breakdown = j.scoreBreakdown;
      if (breakdown) {
        const cache = breakdown.cacheScore ?? 0;
        const quality = breakdown.qualityScore ?? 0;
        const source = breakdown.sourceScore ?? 0;
        const metadata = breakdown.metadataScore ?? 0;
        const popularity = breakdown.popularityScore ?? 0;

        if (cache > 0.5) lines.push(`  +${Math.round((cache - 0.5) * 100)} cached`);
        else if (cache < 0.5) lines.push(`  -${Math.round((0.5 - cache) * 100)} not cached`);

        if (source > 0.7) lines.push(`  +${Math.round(source * 10)} stored corpus`);

        if (quality > 0.7) lines.push(`  +${Math.round(quality * 10)} 2160p`);
        else if (quality > 0.5) lines.push(`  +${Math.round(quality * 10)} 1080p`);
        else if (quality > 0.3) lines.push(`  +${Math.round(quality * 10)} 720p`);

        if (metadata < 0.5) lines.push(`  -${Math.round((0.5 - metadata) * 10)} metadata unknown`);

        if (popularity > 0.7) lines.push(`  +${Math.round(popularity * 10)} title match`);
      }
    }

    // Provenance
    if (winner.provenance) {
      lines.push('');
      lines.push('Source:');
      lines.push(`  ${winner.provenance.source} (${winner.provenance.sourceType})`);
      lines.push(`  discovered: ${winner.provenance.discoveredAt}`);
    }
  }

  // Rejected
  if (trace.rejections.length > 0) {
    lines.push('');
    lines.push(`Rejected (${trace.rejections.length}):`);
    for (const r of trace.rejections) {
      lines.push(`  ${r.hash}`);
      lines.push(`    Reason: ${r.reason}${r.description ? ` — ${r.description}` : ''}`);
    }
  }

  return lines.join('\n');
}
