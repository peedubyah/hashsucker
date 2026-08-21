import type { ChangeEvent } from 'react';
import type { FilterState } from './filter.types';

interface Props {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  resultCount: number;
  totalCount: number;
}

export function FilterBar({ filters, onChange, resultCount, totalCount }: Props) {
  const update = (patch: Partial<FilterState>) => onChange({ ...filters, ...patch });

  const handleQuery = (e: ChangeEvent<HTMLInputElement>) => update({ query: e.target.value });
  const handleSource = (e: ChangeEvent<HTMLSelectElement>) => update({ source: e.target.value as FilterState['source'] });
  const handleResolution = (e: ChangeEvent<HTMLSelectElement>) => update({ resolution: e.target.value });
  const handleQuality = (e: ChangeEvent<HTMLSelectElement>) => update({ quality: e.target.value });
  const handleCached = (e: ChangeEvent<HTMLSelectElement>) => update({ cached: e.target.value as FilterState['cached'] });

  return (
    <div className="filter-bar">
      <div className="filter-row">
        <input
          type="text"
          value={filters.query}
          onChange={handleQuery}
          placeholder="Filter releases..."
          className="filter-input"
        />
        <select value={filters.source} onChange={handleSource} className="filter-select" title="Source">
          <option value="all">All sources</option>
          <option value="corpus">DMM corpus</option>
          <option value="live">Live discovery</option>
        </select>
        <select value={filters.resolution} onChange={handleResolution} className="filter-select" title="Resolution">
          <option value="">All resolutions</option>
          <option value="2160p">2160p</option>
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
        </select>
        <select value={filters.quality} onChange={handleQuality} className="filter-select" title="Quality">
          <option value="">All qualities</option>
          <option value="BluRay">BluRay</option>
          <option value="WEB-DL">WEB-DL</option>
          <option value="WEBRip">WEBRip</option>
          <option value="HDTV">HDTV</option>
          <option value="DVD">DVD</option>
          <option value="HDRip">HDRip</option>
        </select>
        <select value={filters.cached} onChange={handleCached} className="filter-select" title="Cache status">
          <option value="all">Cache: any</option>
          <option value="cached">Cached</option>
          <option value="uncached">Not cached</option>
        </select>
        <span className="filter-count">
          {resultCount}/{totalCount}
        </span>
      </div>
    </div>
  );
}
