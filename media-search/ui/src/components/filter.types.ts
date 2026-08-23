export interface FilterState {
  query: string;
  source: 'all' | 'corpus' | 'live';
  resolution: string;
  quality: string;
  cached: 'all' | 'cached' | 'uncached';
}

export const initialFilters: FilterState = {
  query: '',
  source: 'all',
  resolution: '',
  quality: '',
  cached: 'all',
};
