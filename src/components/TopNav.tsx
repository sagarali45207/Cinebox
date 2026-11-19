import { Bell, BellRing, Moon, Search, Settings, Sun } from 'lucide-react';
import type { NavTab } from '../types/media';

interface TopNavProps {
  activeTab: NavTab;
  theme: 'light' | 'dark';
  reminderCount: number;
  activeDownloadCount?: number;
  parentalLocked?: boolean;
  onToggleTheme: () => void;
  onSelectTab: (tab: NavTab) => void;
  onOpenSearch: () => void;
  onOpenReminders: () => void;
  onOpenSettings: () => void;
}

const NAV_ITEMS: Array<{ id: NavTab; label: string }> = [
  { id: 'discover', label: 'Discover' },
  { id: 'movies', label: 'Movies' },
  { id: 'series', label: 'Series' },
  { id: 'live', label: 'Live TV' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'library', label: 'Library' },
];

export function TopNav({
  activeTab,
  theme,
  reminderCount,
  activeDownloadCount = 0,
  parentalLocked = false,
  onToggleTheme,
  onSelectTab,
  onOpenSearch,
  onOpenReminders,
  onOpenSettings,
}: TopNavProps) {
  return (
    <header className="sticky top-0 z-40 h-14 border-b border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#090B10] transition-colors">
      <div className="mx-auto flex h-full max-w-[1440px] items-center justify-between gap-4 sm:gap-8 px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={() => onSelectTab('discover')}
          className="font-display text-xl font-bold tracking-tight cinebox-brand-gradient hover:opacity-90 transition-opacity whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] rounded"
        >
          CineBox
        </button>

        <nav aria-label="Primary" className="hidden md:flex items-center gap-5 lg:gap-6">
          {NAV_ITEMS.map((item) => {
            const active = activeTab === item.id;
            const showCount = item.id === 'downloads' && activeDownloadCount > 0;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`relative inline-flex items-center gap-1.5 py-2 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] rounded ${
                  active
                    ? 'text-slate-950 dark:text-white font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                <span>{item.label}</span>
                {showCount && (
                  <span className="font-mono text-[11px] font-bold text-[#E11D48] tabular-nums">
                    ({activeDownloadCount})
                  </span>
                )}
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-[#E11D48]"
                  />
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onOpenReminders}
            aria-label={`Show Reminders (${reminderCount})`}
            title="Show Reminders"
            className={`relative inline-flex h-10 w-10 sm:h-9 sm:w-9 items-center justify-center rounded-lg border transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
              reminderCount > 0
                ? 'border-rose-300/80 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/15 text-[#E11D48] dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-500/25'
                : 'border-slate-200 dark:border-white/[0.08] bg-slate-100/80 dark:bg-[#111520] text-slate-700 dark:text-slate-300 hover:bg-slate-200/80 dark:hover:bg-[#171D2B] hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            {reminderCount > 0 ? (
              <BellRing className="h-4 w-4" />
            ) : (
              <Bell className="h-4 w-4" />
            )}
            {reminderCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#E11D48] px-1 text-[10px] font-bold leading-none text-white tabular-nums shadow-sm">
                {reminderCount > 9 ? '9+' : reminderCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
            title={theme === 'light' ? 'Dark Mode' : 'Light Mode'}
            className="inline-flex h-10 w-10 sm:h-9 sm:w-9 items-center justify-center rounded-lg border border-slate-200 dark:border-white/[0.08] bg-slate-100/80 dark:bg-[#111520] text-slate-700 dark:text-slate-300 hover:bg-slate-200/80 dark:hover:bg-[#171D2B] hover:text-slate-950 dark:hover:text-white transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
          >
            {theme === 'light' ? (
              <Moon className="h-4 w-4 text-indigo-600" />
            ) : (
              <Sun className="h-4 w-4 text-amber-400" />
            )}
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={parentalLocked ? 'Open Settings (Parental Control Locked)' : 'Open Settings'}
            title={parentalLocked ? 'Settings • Parental Control Active' : 'Settings'}
            className="relative inline-flex h-10 w-10 sm:h-9 sm:w-9 items-center justify-center rounded-lg border border-slate-200 dark:border-white/[0.08] bg-slate-100/80 dark:bg-[#111520] text-slate-700 dark:text-slate-300 hover:bg-slate-200/80 dark:hover:bg-[#171D2B] hover:text-slate-950 dark:hover:text-white transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
          >
            <Settings className="h-4 w-4" />
            {parentalLocked && (
              <span
                aria-hidden="true"
                className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-white dark:ring-[#111520]"
              />
            )}
          </button>

          <button
            type="button"
            onClick={onOpenSearch}
            aria-label="Open Search"
            className="inline-flex h-10 sm:h-9 items-center gap-2 rounded-lg border border-slate-200 dark:border-white/[0.08] bg-slate-100/80 dark:bg-[#111520] px-3.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-200/80 dark:hover:bg-[#171D2B] hover:text-slate-950 dark:hover:text-white transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
          >
            <Search className="h-3.5 w-3.5 shrink-0 text-[#E11D48]" />
            <span>Search</span>
            <kbd className="hidden sm:inline-block font-mono text-[10px] text-slate-500 dark:text-slate-400">
              ⌘K
            </kbd>
          </button>
        </div>
      </div>
    </header>
  );
}
