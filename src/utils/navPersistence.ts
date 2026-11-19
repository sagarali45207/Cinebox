import type { DetailTarget, NavTab } from '../types/media';

const NAV_STATE_KEY = 'cinebox_nav_state_v1';
const FILTER_KEY_PREFIX = 'cinebox_filters_v1:';

export interface PersistedNavState {
  activeTab: NavTab;
  visitedTabs: NavTab[];
  detailByTab: Partial<Record<NavTab, DetailTarget | null>>;
  scrollPositions: Record<string, number>;
  updatedAt: number;
}

export interface CatalogFilterSnapshot {
  categoryId: string;
  selectedGenre: string;
  sort: 'newest' | 'rating' | 'az';
  query: string;
  page: number;
}

export interface LiveFilterSnapshot {
  categoryId: string;
  selectedGenre: string;
  filterMode: 'all' | 'epg' | 'catchup' | 'favorites';
  query: string;
  page: number;
}

export interface EpgFilterSnapshot {
  categoryId: string;
  query: string;
  catchupOnly: boolean;
  offsetHours: number;
  viewMode: 'timeline' | 'cards';
  density: 'cozy' | 'compact';
  page: number;
}

export function loadNavState(): PersistedNavState {
  clearNavPersistence();
  return {
    activeTab: 'discover',
    visitedTabs: ['discover'],
    detailByTab: {},
    scrollPositions: {},
    updatedAt: Date.now(),
  };
}

export function saveNavState(_state: Omit<PersistedNavState, 'updatedAt'>): void {
  // Intentionally do not persist active screen/detail/playback across app restarts.
  // In-session tab switching preserves mounted views and detail state in React memory.
}

export function loadViewFilters<T>(_viewKey: string, defaults: T): T {
  return { ...defaults };
}

export function saveViewFilters<T>(_viewKey: string, _filters: T): void {
  // Intentionally do not persist filters across app restarts.
  // CatalogView, LiveTvView, and EpgGuideView remain mounted in memory across tab switches.
}

export function clearNavPersistence(): void {
  try {
    if (typeof window === 'undefined') return;
    const clearStore = (store: Storage | undefined) => {
      if (!store) return;
      store.removeItem(NAV_STATE_KEY);
      const keysToRemove: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (k && k.startsWith(FILTER_KEY_PREFIX)) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) {
        store.removeItem(k);
      }
    };
    clearStore(window.localStorage);
    clearStore(window.sessionStorage);
  } catch {
    // Ignore storage errors
  }
}
