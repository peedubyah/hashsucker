import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import {
  fetchTitleSearch, submitMediaRequest, submitDownloadRequest,
  type MediaSearchResult, type RequestIntent,
} from '@/api';
import { usePoll } from '@/lib/use-poll';
import { PageHeader, Section, EmptyState, ErrorState, LoadingState } from '@/components/common';

const INTENTS: { value: RequestIntent | 'download'; label: string }[] = [
  { value: 'library', label: 'Add to library' },
  { value: 'watch', label: 'Watch once' },
  { value: 'immediate', label: 'Best available now' },
  { value: 'download', label: 'Download' },
];
const PROFILES = ['balanced', 'hd', 'max'] as const;

function ResultCard({ result, onRequest }: { result: MediaSearchResult; onRequest: (r: MediaSearchResult) => void }) {
  return (
    <article className="media-result">
      {result.posterUrl ? <img className="media-poster" src={result.posterUrl} alt="" /> : <div className="media-poster media-poster-empty">🎬</div>}
      <div className="media-result-body">
        <h2>{result.title}</h2>
        <p className="muted">{result.year ?? 'Year unknown'} · {result.type === 'series' ? 'Series' : 'Movie'}</p>
        {result.overview && <p className="media-overview">{result.overview}</p>}
        <button type="button" className="btn btn-primary" onClick={() => onRequest(result)}>Request</button>
      </div>
    </article>
  );
}

export function HomePage() {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [selected, setSelected] = useState<MediaSearchResult | null>(null);
  const [intent, setIntent] = useState<RequestIntent | 'download'>('library');
  const [profile, setProfile] = useState<(typeof PROFILES)[number]>('balanced');
  const [notice, setNotice] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [data, error, refresh] = usePoll(useCallback(() => submitted ? fetchTitleSearch(submitted) : Promise.resolve({ results: [] }), [submitted]), 30_000);

  const search = (e: FormEvent) => { e.preventDefault(); setNotice(null); setSubmitted(query.trim()); };
  const request = async (result: MediaSearchResult) => {
    setRequesting(true); setNotice(null);
    try {
      const out = intent === 'download'
        ? await submitDownloadRequest({
          mediaId: result.id, mediaType: result.type === 'series' ? 'series' : 'movie',
          qualityProfile: profile, title: result.title, year: result.year ?? undefined,
        })
        : await submitMediaRequest({
          mediaId: result.id, mediaType: result.type === 'series' ? 'series' : 'movie',
          intent, qualityProfile: profile, mediaTitle: result.title,
          source: 'web', sourceType: 'household', sourceLabel: result.title,
          posterUrl: result.posterUrl ?? undefined,
          canonicalTitle: result.title, canonicalYear: result.year ?? undefined,
        });
      const requestId = 'requestId' in out ? out.requestId : null;
      setNotice(intent === 'download'
        ? `${result.title} — download requested and is now in Downloads.`
        : `${result.title} — request ${requestId ? 'accepted' : 'completed'} and is now in Requests.`);
      setSelected(null);
    } catch (err) { setNotice(`Could not request ${result.title}: ${(err as Error).message}`); }
    finally { setRequesting(false); }
  };

  return (
    <div className="page home-page">
      <PageHeader title="What do you want to watch?" subtitle="Search your media, then choose the outcome you want. HashSucker handles the mechanics." />
      <form className="hero-search" onSubmit={search}>
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search movies and TV…" aria-label="Search movies and TV" />
        <button className="btn btn-primary" type="submit" disabled={query.trim().length < 2}>Search</button>
      </form>
      {notice && <Section dense><div className="notice" role="status">{notice}</div></Section>}
      {error && <ErrorState message={error} onRetry={() => void refresh()} />}
      {selected && (
        <Section title={`How should HashSucker handle ${selected.title}?`}>
          <div className="request-options">
            {INTENTS.map((item) => <button key={item.value} type="button" className={`choice ${intent === item.value ? 'selected' : ''}`} onClick={() => setIntent(item.value)}>{item.label}</button>)}
            <label className="compact-select"><span>Quality</span><select value={profile} onChange={(e) => setProfile(e.target.value as typeof profile)}>{PROFILES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</select></label>
            <button className="btn btn-primary" type="button" disabled={requesting} onClick={() => void request(selected)}>{requesting ? 'Requesting…' : 'Confirm request'}</button>
            <button className="btn btn-secondary" type="button" onClick={() => setSelected(null)}>Cancel</button>
          </div>
        </Section>
      )}
      {submitted && !data && !error && <LoadingState label="Searching…" />}
      {submitted && data && <Section title="Search results" description={`${data.results.length} matches`}>
        {data.results.length === 0 ? <EmptyState title="Nothing found" detail="Try another title." /> : <div className="media-results">{data.results.map((r) => <ResultCard key={`${r.type}:${r.id}`} result={r} onRequest={setSelected} />)}</div>}
      </Section>}
      {!submitted && <Section title="Start with a title" description="Search results stay focused on movies and shows — never torrent candidates."><p className="muted">Search by title to see artwork and choose what you want HashSucker to do.</p></Section>}
    </div>
  );
}
