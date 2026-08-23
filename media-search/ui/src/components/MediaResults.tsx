import type { TitleResult } from '@/types/api';

interface Props {
  titles: TitleResult[];
  onSelect: (type: string, id: string) => void;
}

export function MediaResults({ titles, onSelect }: Props) {
  if (titles.length === 0) {
    return <div className="empty-state">No titles found.</div>;
  }

  return (
    <div className="media-results">
      <h2>Select a title</h2>
      <ul className="media-list">
        {titles.map(t => (
          <li key={t.id} className="media-item">
            <button
              type="button"
              className="media-select"
              onClick={() => onSelect(t.type, t.id)}
            >
              {t.posterUrl && (
                <img src={t.posterUrl} alt="" className="media-poster" loading="lazy" />
              )}
              <div className="media-info">
                <span className="media-name">{t.title}</span>
                <span className="media-meta">
                  {t.type} {t.year && `· ${t.year}`}
                </span>
                {t.overview && (
                  <span className="media-desc">{t.overview}</span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
