import { Bookmark, Clapperboard, Compass, Download, Film, Radio } from 'lucide-react';
import type { NavTab } from '../types/media';

interface BottomNavProps {
  activeTab: NavTab;
  activeDownloadCount?: number;
  onSelectTab: (tab: NavTab) => void;
}

const MOBILE_TABS: Array<{
  id: NavTab;
  label: string;
  Icon: typeof Compass;
}> = [
  { id: 'discover', label: 'Discover', Icon: Compass },
  { id: 'movies', label: 'Movies', Icon: Film },
  { id: 'series', label: 'Series', Icon: Clapperboard },
  { id: 'live', label: 'Live TV', Icon: Radio },
  { id: 'downloads', label: 'Downloads', Icon: Download },
  { id: 'library', label: 'Library', Icon: Bookmark },
];

export function BottomNav({
  activeTab,
  activeDownloadCount = 0,
  onSelectTab,
}: BottomNavProps) {
  return (
    <nav
      aria-label="Mobile Navigation"
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#090B10] pb-[env(safe-area-inset-bottom)] transition-colors"
    >
      <div className="grid h-15 grid-cols-6 items-center px-1">
        {MOBILE_TABS.map(({ id, label, Icon }) => {
          const active = activeTab === id;
          const showBadge = id === 'downloads' && activeDownloadCount > 0;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelectTab(id)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
                active
                  ? 'text-[#E11D48] font-semibold'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <span className="relative inline-flex items-center justify-center">
                <Icon className="h-5 w-5 shrink-0" strokeWidth={active ? 2.2 : 1.75} />
                {showBadge && (
                  <span className="absolute -right-2 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#E11D48] px-1 text-[9px] font-bold leading-none text-white tabular-nums shadow-sm">
                    {activeDownloadCount > 9 ? '9+' : activeDownloadCount}
                  </span>
                )}
              </span>
              <span className="text-[10px] font-medium leading-none tracking-tight whitespace-nowrap">
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
