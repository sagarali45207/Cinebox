import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HardDriveDownload, WifiOff } from 'lucide-react';
import { BottomNav } from './components/BottomNav';
import { CatalogView } from './components/CatalogView';
import { DiscoverView } from './components/DiscoverView';
import { LibraryView, type LibraryTab } from './components/LibraryView';
import { LiveTvView } from './components/LiveTvView';
import { PageLoader } from './components/LoadingSpinner';
import { OmniSearchModal, type SearchPersonContext } from './components/OmniSearchModal';
import { ReminderToastStack } from './components/ReminderToastStack';
import { StartupErrorPage } from './components/StartupErrorPage';
import { TopNav } from './components/TopNav';

const DownloadManagerView = lazy(() =>
  import('./components/DownloadManagerView').then((m) => ({ default: m.DownloadManagerView })),
);
const EpgGuideView = lazy(() =>
  import('./components/EpgGuideView').then((m) => ({ default: m.EpgGuideView })),
);
const MediaDetailPage = lazy(() =>
  import('./components/MediaDetailPage').then((m) => ({ default: m.MediaDetailPage })),
);
const RemindersModal = lazy(() =>
  import('./components/RemindersModal').then((m) => ({ default: m.RemindersModal })),
);
const SettingsModal = lazy(() =>
  import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal })),
);
import { fetchHome, omniSearch } from './services/api';
import type {
  ActivePlayback,
  DetailTarget,
  EpgProgram,
  HomePayload,
  LiveChannelSummary,
  NavTab,
  ProgramReminder,
  ReminderLeadMinutes,
  WatchHistoryEntry,
  WatchlistEntry,
} from './types/media';
import {
  fireBrowserNotification,
  getNotificationPermissionState,
  playReminderChime,
  requestBrowserNotificationPermission,
} from './utils/notifications';
import { clearNavPersistence } from './utils/navPersistence';
import {
  probeServerConnectivity,
  sanitizeUserErrorMessage,
  type ConnectivityErrorReason,
} from './utils/networkError';
import { useOfflineDownloads } from './utils/offlineManager';
import { useAppSettings } from './utils/settings';
import {
  buildReminderId,
  clearProgramReminders,
  clearRecentChannels,
  clearWatchProgress,
  getContinueWatching,
  getFavoriteChannels,
  getProgramReminders,
  getRecentChannels,
  getWatchlist,
  markReminderNotified,
  pushRecentChannel,
  removeProgramReminder,
  removeRecentChannel,
  removeWatchProgress,
  saveProgramReminder,
  saveWatchProgress,
  toggleFavoriteChannel,
  toggleWatchlist,
} from './utils/storage';

const BACK_LABEL_BY_TAB: Record<NavTab, string> = {
  discover: 'Back to Discover',
  movies: 'Back to Movies',
  series: 'Back to Series',
  live: 'Back to Live TV',
  epg: 'Back to TV Guide',
  downloads: 'Back to Downloads',
  library: 'Back to Library',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('discover');
  const [home, setHome] = useState<HomePayload | null>(null);
  const [homeLoading, setHomeLoading] = useState(true);
  const [homeError, setHomeError] = useState('');

  const [continueEntries, setContinueEntries] = useState<WatchHistoryEntry[]>(() =>
    getContinueWatching(),
  );
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>(() => getWatchlist());
  const [favoriteChannels, setFavoriteChannels] = useState<LiveChannelSummary[]>(() =>
    getFavoriteChannels(),
  );
  const [recentChannels, setRecentChannels] = useState<LiveChannelSummary[]>(() =>
    getRecentChannels(),
  );
  const [reminders, setReminders] = useState<ProgramReminder[]>(() => getProgramReminders());
  const [activeAlerts, setActiveAlerts] = useState<ProgramReminder[]>([]);

  const [activeDetail, setActiveDetail] = useState<{
    tab: NavTab;
    target: DetailTarget;
  } | null>(null);
  const [visitedTabs, setVisitedTabs] = useState<Set<NavTab>>(() => new Set(['discover']));
  const activeTabRef = useRef<NavTab>(activeTab);
  const activeDetailRef = useRef(activeDetail);
  const detailEpochRef = useRef(1);
  const scrollPositionsRef = useRef<Record<string, number>>({});
  activeTabRef.current = activeTab;
  activeDetailRef.current = activeDetail;

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchPerson, setSearchPerson] = useState<SearchPersonContext | null>(null);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { isParentalLocked } = useAppSettings();
  const [libraryJump, setLibraryJump] = useState<{ section: LibraryTab; nonce: number }>({
    section: 'watchlist',
    nonce: 0,
  });
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [bootStatus, setBootStatus] = useState<'checking' | 'ready' | 'error'>(() =>
    typeof navigator !== 'undefined' && navigator.onLine === false ? 'error' : 'checking',
  );
  const [bootErrorReason, setBootErrorReason] = useState<ConnectivityErrorReason>(() =>
    typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'no-data',
  );
  const [bootRetrying, setBootRetrying] = useState(false);
  const [offlineDownloadsBypass, setOfflineDownloadsBypass] = useState(false);
  const bootStatusRef = useRef(bootStatus);
  bootStatusRef.current = bootStatus;
  const { downloads: offlineDownloads, tasks: offlineTasks } = useOfflineDownloads();
  const activeDownloadCount = Object.values(offlineTasks).filter(
    (t) => t.status === 'queued' || t.status === 'downloading' || t.status === 'saving',
  ).length;
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return localStorage.getItem('cinebox_theme') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', theme === 'dark' ? '#090B10' : '#F6F8FC');
    }
    try {
      localStorage.setItem('cinebox_theme', theme);
    } catch {
      // Ignore storage restrictions
    }
  }, [theme]);

  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  }, []);

  const loadHome = useCallback((signal?: AbortSignal) => {
    setHomeLoading(true);
    setHomeError('');
    fetchHome(signal)
      .then((data) => {
        setHome(data);
        setHomeLoading(false);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setHomeError(sanitizeUserErrorMessage(err?.message));
        setHomeLoading(false);
      });
  }, []);

  const verifyStartupConnectivity = useCallback(
    async (triggerHomeReload = false) => {
      setBootRetrying(true);
      const probe = await probeServerConnectivity(8000);
      setBootRetrying(false);

      if (probe.reachable) {
        setIsOnline(true);
        setBootStatus('ready');
        setOfflineDownloadsBypass(false);
        if (triggerHomeReload || !home) {
          loadHome();
        }
        return true;
      }

      setBootErrorReason(probe.reason === 'offline' ? 'offline' : 'no-data');
      setBootStatus('error');
      return false;
    },
    [home, loadHome],
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setBootErrorReason('offline');
      setBootStatus('error');
      setHomeLoading(false);
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    loadHome(controller.signal);
    void probeServerConnectivity(8000).then((probe) => {
      if (cancelled) return;
      if (probe.reachable) {
        setBootStatus('ready');
      } else {
        setBootErrorReason(probe.reason === 'offline' ? 'offline' : 'no-data');
        setBootStatus('error');
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [loadHome]);

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      if (bootStatusRef.current === 'error') {
        void verifyStartupConnectivity(true);
      }
    };
    const onOffline = () => {
      setIsOnline(false);
      if (bootStatusRef.current === 'checking') {
        setBootErrorReason('offline');
        setBootStatus('error');
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [verifyStartupConnectivity]);

  // Global Cmd+K / Ctrl+K shortcut for Omni-Search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchPerson(null);
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const saveCurrentScroll = useCallback(() => {
    if (activeDetailRef.current) return;
    scrollPositionsRef.current[activeTabRef.current] = window.scrollY;
  }, []);

  const restoreScrollPosition = useCallback((top: number) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.scrollTo({ top, behavior: 'auto' });
      });
    });
  }, []);

  const restoreScrollForTab = useCallback(
    (tab: NavTab) => {
      const saved = scrollPositionsRef.current[tab] ?? 0;
      restoreScrollPosition(saved);
    },
    [restoreScrollPosition],
  );

  // Always start fresh on Discover home screen upon app startup/restart (no restored detail/playback/history)
  useEffect(() => {
    clearNavPersistence();
    try {
      if ('scrollRestoration' in window.history) {
        window.history.scrollRestoration = 'manual';
      }
      window.history.replaceState({ view: 'tab', tab: 'discover' }, '');
    } catch {
      // Ignore history restrictions
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  // Track in-session scroll positions purely in memory for seamless tab switching
  useEffect(() => {
    let scrollSaveTimer: number | null = null;
    const onScroll = () => {
      if (scrollSaveTimer !== null) return;
      scrollSaveTimer = window.setTimeout(() => {
        scrollSaveTimer = null;
        saveCurrentScroll();
      }, 250);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (scrollSaveTimer !== null) window.clearTimeout(scrollSaveTimer);
      window.removeEventListener('scroll', onScroll);
    };
  }, [saveCurrentScroll]);

  const markTabVisited = useCallback((tab: NavTab) => {
    setVisitedTabs((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, []);

  // Browser Back / Android hardware Back integration for dedicated Detail Page
  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      saveCurrentScroll();
      const st = e.state as {
        view?: string;
        target?: DetailTarget;
        tab?: NavTab;
        epoch?: number;
      } | null;
      if (st?.view === 'detail' && st.target && st.epoch === detailEpochRef.current) {
        const targetTab = st.tab || activeTabRef.current;
        markTabVisited(targetTab);
        setActiveTab(targetTab);
        setActiveDetail({ tab: targetTab, target: st.target });
        restoreScrollPosition(0);
      } else {
        const targetTab = st?.tab || activeTabRef.current;
        detailEpochRef.current += 1;
        markTabVisited(targetTab);
        setActiveTab(targetTab);
        setActiveDetail(null);
        restoreScrollForTab(targetTab);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [markTabVisited, restoreScrollForTab, restoreScrollPosition, saveCurrentScroll]);

  const handleOpenDetail = useCallback(
    (target: DetailTarget) => {
      saveCurrentScroll();
      const tab = activeDetailRef.current?.tab ?? activeTabRef.current;
      try {
        window.history.pushState(
          { view: 'detail', tab, target, epoch: detailEpochRef.current },
          '',
        );
      } catch {
        // Ignore history restrictions in embedded frames
      }
      setActiveDetail({ tab, target });
      restoreScrollPosition(0);
    },
    [restoreScrollPosition, saveCurrentScroll],
  );

  const handleNavigateInsideDetail = useCallback(
    (next: DetailTarget) => {
      saveCurrentScroll();
      const tab = activeDetailRef.current?.tab ?? activeTabRef.current;
      try {
        window.history.replaceState(
          { view: 'detail', tab, target: next, epoch: detailEpochRef.current },
          '',
        );
      } catch {
        // Ignore history restrictions
      }
      setActiveDetail({ tab, target: next });
      restoreScrollPosition(0);
    },
    [restoreScrollPosition, saveCurrentScroll],
  );

  const handleBackFromDetail = useCallback(() => {
    const tab = activeTabRef.current;
    detailEpochRef.current += 1;
    setActiveDetail(null);
    try {
      if (window.history.state?.view === 'detail') {
        window.history.replaceState({ view: 'tab', tab }, '');
      }
    } catch {
      // Ignore history restrictions
    }
    restoreScrollForTab(tab);
  }, [restoreScrollForTab]);

  const handleSelectTab = useCallback(
    (tab: NavTab) => {
      saveCurrentScroll();
      markTabVisited(tab);
      const prevTab = activeTabRef.current;
      const hadActiveDetail = Boolean(activeDetailRef.current);

      if (hadActiveDetail) {
        // Switching away or tapping the active tab clears the standalone MediaDetailPage
        detailEpochRef.current += 1;
        setActiveDetail(null);
        try {
          if (window.history.state?.view === 'detail') {
            window.history.replaceState({ view: 'tab', tab }, '');
          }
        } catch {
          // Ignore history errors
        }
      }

      if (tab === prevTab) {
        if (hadActiveDetail) {
          restoreScrollForTab(tab);
        } else {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        return;
      }

      setActiveTab(tab);
      restoreScrollForTab(tab);
    },
    [markTabVisited, restoreScrollForTab, saveCurrentScroll],
  );

  const handleOpenOfflineDownloads = useCallback(() => {
    handleSelectTab('downloads');
  }, [handleSelectTab]);

  const handleOpenContinue = useCallback(
    async (entry: WatchHistoryEntry) => {
      if (entry.kind === 'movie') {
        handleOpenDetail({
          kind: 'movie',
          id: entry.id,
          autoplay: true,
          resumeSec: entry.progressSec,
          initialMovie: {
            title: entry.title,
            poster: entry.poster,
            playUrl: entry.playUrl,
            extension: entry.extension,
          },
        });
        return;
      }

      if (entry.seriesId) {
        handleOpenDetail({
          kind: 'series',
          id: entry.seriesId,
          episodeId: entry.id,
          seasonNum: entry.seasonNum,
          episodeNum: entry.episodeNum,
          resumeSec: entry.progressSec,
        });
        return;
      }

      if (entry.seriesTitle) {
        try {
          const res = await omniSearch(entry.seriesTitle);
          const normTitle = entry.seriesTitle.trim().toLowerCase();
          const matched =
            res.series.find((s) => s.cleanTitle.toLowerCase() === normTitle) || res.series[0];
          if (matched) {
            handleOpenDetail({
              kind: 'series',
              id: matched.seriesId,
              episodeId: entry.id,
              seasonNum: entry.seasonNum,
              episodeNum: entry.episodeNum,
              resumeSec: entry.progressSec,
            });
            return;
          }
        } catch {
          // Ignore fallback search failure
        }
      }

      setSearchOpen(true);
    },
    [handleOpenDetail],
  );

  const handleChannelOpened = useCallback((channel: LiveChannelSummary) => {
    setRecentChannels(pushRecentChannel(channel));
  }, []);

  function handleToggleSave(payload: {
    kind: 'movie' | 'series';
    id: string;
    title: string;
    poster: string;
    year: string | null;
    rating: number;
    categoryName: string;
  }) {
    const res = toggleWatchlist(payload);
    setWatchlist(res.list);
  }

  function handleToggleFavoriteChannel(channel: LiveChannelSummary) {
    const res = toggleFavoriteChannel(channel);
    setFavoriteChannels(res.list);
  }

  const handlePlaybackProgress = useCallback(
    (playback: ActivePlayback, currentTime: number, duration: number) => {
      if (playback.kind !== 'movie' && playback.kind !== 'episode') return;
      if (currentTime < 5) return;

      const key = `${playback.kind}:${playback.id}`;
      const updated = saveWatchProgress({
        key,
        kind: playback.kind,
        id: playback.id,
        seriesId: playback.seriesDetail?.seriesId || playback.seriesId,
        seriesTitle:
          playback.seriesDetail?.cleanTitle ||
          (playback.kind === 'episode' ? playback.subtitle : undefined),
        seasonNum: playback.seasonNum,
        episodeNum: playback.episodeNum,
        title: playback.title,
        poster: playback.poster || '',
        playUrl: playback.playUrl,
        extension: playback.extension || 'mp4',
        progressSec: Math.floor(currentTime),
        durationSec: Math.floor(duration),
        updatedAt: Date.now(),
        categoryName:
          playback.seriesDetail?.categoryName ||
          (playback.kind === 'movie' ? playback.subtitle : undefined),
        rating: playback.rating ?? playback.seriesDetail?.rating,
        language: playback.language,
      });
      setContinueEntries(updated);
    },
    [],
  );

  // EPG Show Reminder Scheduler — checks due reminders only when un-notified reminders exist and tab is visible
  const hasPendingReminders = useMemo(
    () => reminders.some((rem) => !rem.notified),
    [reminders],
  );

  useEffect(() => {
    if (!hasPendingReminders) return;

    const checkDueReminders = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const nowSec = Math.floor(Date.now() / 1000);
      const due = reminders.filter((rem) => {
        if (rem.notified) return false;
        const triggerAt = rem.startTimestamp - rem.leadMinutes * 60;
        return nowSec >= triggerAt && nowSec <= rem.stopTimestamp;
      });
      if (due.length === 0) return;

      let updatedList = reminders;
      for (const rem of due) {
        updatedList = markReminderNotified(rem.id);
        playReminderChime();
        fireBrowserNotification(rem, () => {
          handleOpenDetail({
            kind: 'live',
            id: rem.streamId,
            channel: rem.channelSnapshot,
          });
        });
      }
      setReminders(updatedList);
      setActiveAlerts((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const additions = due.filter((d) => !seen.has(d.id));
        return [...additions, ...prev].slice(0, 4);
      });
    };

    checkDueReminders();
    let timer: number | null =
      typeof document === 'undefined' || document.visibilityState === 'visible'
        ? window.setInterval(checkDueReminders, 15_000)
        : null;

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        checkDueReminders();
        if (timer === null) {
          timer = window.setInterval(checkDueReminders, 15_000);
        }
      } else if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [reminders, hasPendingReminders, handleOpenDetail]);

  const handleToggleReminder = useCallback(
    (
      channel: LiveChannelSummary,
      program: EpgProgram,
      leadMinutes: ReminderLeadMinutes = 5,
    ) => {
      const id = buildReminderId(
        channel.streamId,
        program.startTimestamp,
        program.id || program.title,
      );
      const exists = reminders.some((r) => r.id === id);
      if (exists) {
        setReminders(removeProgramReminder(id));
        setActiveAlerts((prev) => prev.filter((a) => a.id !== id));
        return;
      }

      if (getNotificationPermissionState() === 'default') {
        void requestBrowserNotificationPermission();
      }

      const next = saveProgramReminder({
        id,
        streamId: channel.streamId,
        channelName: channel.name,
        channelLogo: channel.logo,
        channelCategory: channel.categoryName,
        programId: program.id,
        programTitle: program.title,
        programDescription: program.description,
        startTimestamp: program.startTimestamp,
        stopTimestamp: program.stopTimestamp,
        startLabel: program.startLabel,
        stopLabel: program.stopLabel,
        leadMinutes,
        createdAt: Date.now(),
        notified: false,
        channelSnapshot: channel,
      });
      setReminders(next);
    },
    [reminders],
  );

  const handleUpdateReminderLeadTime = useCallback(
    (id: string, leadMinutes: ReminderLeadMinutes) => {
      const target = reminders.find((r) => r.id === id);
      if (!target) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const shouldResetNotified = nowSec < target.startTimestamp - leadMinutes * 60;
      const next = saveProgramReminder({
        ...target,
        leadMinutes,
        notified: shouldResetNotified ? false : target.notified,
      });
      setReminders(next);
    },
    [reminders],
  );

  const handleRemoveReminder = useCallback((id: string) => {
    setReminders(removeProgramReminder(id));
    setActiveAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleClearReminders = useCallback(() => {
    setReminders(clearProgramReminders());
    setActiveAlerts([]);
  }, []);

  const handleSendTestAlert = useCallback(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const sample = reminders[0] || {
      id: `test-${nowSec}`,
      streamId: home?.featuredLive?.[0]?.streamId || '0',
      channelName: home?.featuredLive?.[0]?.name || 'CineBox Live TV',
      channelLogo: home?.featuredLive?.[0]?.logo || '',
      channelCategory: home?.featuredLive?.[0]?.categoryName || 'Featured',
      programId: 'test',
      programTitle: 'Upcoming Show Alert Ready',
      startTimestamp: nowSec + 300,
      stopTimestamp: nowSec + 3900,
      startLabel: 'Soon',
      stopLabel: '+1h',
      leadMinutes: 5 as ReminderLeadMinutes,
      createdAt: Date.now(),
      channelSnapshot: home?.featuredLive?.[0],
    };
    playReminderChime();
    fireBrowserNotification(sample);
    setActiveAlerts((prev) => [sample, ...prev.filter((a) => a.id !== sample.id)].slice(0, 4));
  }, [reminders, home]);

  const showStartupErrorPage =
    !offlineDownloadsBypass &&
    (bootStatus === 'error' || (bootStatus === 'ready' && Boolean(homeError) && !home && !homeLoading));

  if (showStartupErrorPage) {
    return (
      <StartupErrorPage
        reason={!isOnline ? 'offline' : bootErrorReason}
        retrying={bootRetrying}
        offlineDownloadsCount={offlineDownloads.length}
        onRetry={() => {
          void verifyStartupConnectivity(true);
        }}
        onOpenOfflineDownloads={() => {
          setOfflineDownloadsBypass(true);
          markTabVisited('downloads');
          setActiveTab('downloads');
          detailEpochRef.current += 1;
          setActiveDetail(null);
        }}
      />
    );
  }

  if (bootStatus === 'checking' && !offlineDownloadsBypass) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F6F8FC] dark:bg-[#090B10] px-4">
        <PageLoader
          label="Starting CineBox..."
          sublabel="Checking connection status"
          className="py-12"
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col text-slate-900 dark:text-slate-100">
      <TopNav
        activeTab={activeTab}
        theme={theme}
        reminderCount={reminders.length}
        activeDownloadCount={activeDownloadCount}
        parentalLocked={isParentalLocked}
        onToggleTheme={handleToggleTheme}
        onSelectTab={handleSelectTab}
        onOpenSearch={() => {
          setSearchPerson(null);
          setSearchOpen(true);
        }}
        onOpenReminders={() => setRemindersOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="flex-1">
        {(!isOnline || bootStatus === 'error') && (
          <div className="border-b border-amber-300/70 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-950/60">
            <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6 lg:px-8 text-xs">
              <div className="flex items-center gap-2 text-amber-900 dark:text-amber-200 font-medium">
                <WifiOff className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>
                  You are currently offline
                  {offlineDownloads.length > 0
                    ? ` — ${offlineDownloads.length} saved title${offlineDownloads.length > 1 ? 's' : ''} ready to play without internet.`
                    : ' — Downloaded movies and episodes remain playable from Offline Downloads.'}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {bootStatus === 'error' && (
                  <button
                    type="button"
                    disabled={bootRetrying}
                    onClick={() => {
                      void verifyStartupConnectivity(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/70 dark:border-amber-500/40 bg-white/80 dark:bg-white/10 px-3 py-1.5 text-xs font-semibold text-amber-900 dark:text-amber-100 hover:bg-white dark:hover:bg-white/15 transition-colors whitespace-nowrap disabled:opacity-60"
                  >
                    <span>{bootRetrying ? 'Checking...' : 'Retry Connection'}</span>
                  </button>
                )}
                {!(activeTab === 'downloads' && !activeDetail) && (
                  <button
                    type="button"
                    onClick={handleOpenOfflineDownloads}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 transition-colors whitespace-nowrap"
                  >
                    <HardDriveDownload className="h-3.5 w-3.5" />
                    <span>Open Download Manager ({offlineDownloads.length})</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Standalone MediaDetailPage — unmounts and clears immediately whenever the user switches tabs or navigates back */}
        {activeDetail && (
          <Suspense fallback={<div className="py-16 flex justify-center"><PageLoader label="Loading player..." /></div>}>
            <MediaDetailPage
              key={`${activeDetail.target.kind}:${activeDetail.target.id}`}
              target={activeDetail.target}
              isActive
              watchlist={watchlist}
              continueEntries={continueEntries}
              favoriteChannels={favoriteChannels}
              reminders={reminders}
              backLabel={BACK_LABEL_BY_TAB[activeDetail.tab]}
              onBack={handleBackFromDetail}
              onNavigateDetail={handleNavigateInsideDetail}
              onSelectRelated={handleOpenDetail}
              onToggleSave={handleToggleSave}
              onToggleFavoriteChannel={handleToggleFavoriteChannel}
              onToggleReminder={handleToggleReminder}
              onChannelOpened={handleChannelOpened}
              onProgress={handlePlaybackProgress}
              onOpenDownloads={handleOpenOfflineDownloads}
              onSearchCastMember={(member, exclude) => {
                setSearchPerson({
                  member,
                  excludeKind: exclude?.kind,
                  excludeId: exclude?.id,
                });
                setSearchOpen(true);
              }}
            />
          </Suspense>
        )}

        {/* Keep visited tab root views mounted (hidden via CSS) so each tab's last screen, filters, and data persist seamlessly */}
        {visitedTabs.has('discover') && (
          <div className={!activeDetail && activeTab === 'discover' ? 'block' : 'hidden'}>
            <DiscoverView
              home={home}
              loading={homeLoading}
              error={homeError}
              continueEntries={continueEntries}
              watchlist={watchlist}
              onRetry={() => loadHome()}
              onNavigate={handleSelectTab}
              onOpenSearch={() => {
                setSearchPerson(null);
                setSearchOpen(true);
              }}
              onOpenDetail={handleOpenDetail}
              onOpenContinue={handleOpenContinue}
              onToggleSave={handleToggleSave}
              onRemoveContinue={(key) => setContinueEntries(removeWatchProgress(key))}
              offlineCount={offlineDownloads.length}
              onOpenOfflineDownloads={handleOpenOfflineDownloads}
            />
          </div>
        )}

        {visitedTabs.has('movies') && (
          <div className={!activeDetail && activeTab === 'movies' ? 'block' : 'hidden'}>
            <CatalogView
              mode="movies"
              home={home}
              watchlist={watchlist}
              onOpenDetail={handleOpenDetail}
              onOpenDownloads={handleOpenOfflineDownloads}
              onToggleSave={handleToggleSave}
            />
          </div>
        )}

        {visitedTabs.has('series') && (
          <div className={!activeDetail && activeTab === 'series' ? 'block' : 'hidden'}>
            <CatalogView
              mode="series"
              home={home}
              watchlist={watchlist}
              onOpenDetail={handleOpenDetail}
              onOpenDownloads={handleOpenOfflineDownloads}
              onToggleSave={handleToggleSave}
            />
          </div>
        )}

        {visitedTabs.has('live') && (
          <div className={!activeDetail && activeTab === 'live' ? 'block' : 'hidden'}>
            <LiveTvView
              home={home}
              favoriteChannels={favoriteChannels}
              onSelectChannel={(ch) =>
                handleOpenDetail({ kind: 'live', id: ch.streamId, channel: ch })
              }
              onToggleFavoriteChannel={handleToggleFavoriteChannel}
            />
          </div>
        )}

        {visitedTabs.has('epg') && (
          <div className={!activeDetail && activeTab === 'epg' ? 'block' : 'hidden'}>
            <Suspense fallback={<div className="py-16 flex justify-center"><PageLoader label="Loading TV guide..." /></div>}>
              <EpgGuideView
                reminders={reminders}
                onToggleReminder={handleToggleReminder}
                onUpdateReminderLeadTime={handleUpdateReminderLeadTime}
                onOpenReminders={() => setRemindersOpen(true)}
                onOpenDetail={handleOpenDetail}
              />
            </Suspense>
          </div>
        )}

        {visitedTabs.has('downloads') && (
          <div className={!activeDetail && activeTab === 'downloads' ? 'block' : 'hidden'}>
            <Suspense fallback={<div className="py-16 flex justify-center"><PageLoader label="Loading downloads..." /></div>}>
              <DownloadManagerView
                isOnline={isOnline}
                onOpenDetail={handleOpenDetail}
                onBrowseCatalog={() => handleSelectTab('discover')}
              />
            </Suspense>
          </div>
        )}

        {visitedTabs.has('library') && (
          <div className={!activeDetail && activeTab === 'library' ? 'block' : 'hidden'}>
            <LibraryView
              continueEntries={continueEntries}
              watchlist={watchlist}
              favoriteChannels={favoriteChannels}
              recentChannels={recentChannels}
              reminders={reminders}
              initialSection={libraryJump.section}
              sectionNonce={libraryJump.nonce}
              onOpenContinue={handleOpenContinue}
              onOpenDetail={handleOpenDetail}
              onToggleSave={handleToggleSave}
              onToggleFavoriteChannel={handleToggleFavoriteChannel}
              onRemoveContinue={(key) => setContinueEntries(removeWatchProgress(key))}
              onClearContinue={() => setContinueEntries(clearWatchProgress())}
              onRemoveRecentChannel={(streamId) =>
                setRecentChannels(removeRecentChannel(streamId))
              }
              onClearRecentChannels={() => setRecentChannels(clearRecentChannels())}
              onRemoveReminder={handleRemoveReminder}
              onClearReminders={handleClearReminders}
            />
          </div>
        )}
      </main>

      <footer className="border-t border-slate-200/80 dark:border-white/[0.06] bg-white dark:bg-[#090B10] py-6 pb-[calc(5.25rem+env(safe-area-inset-bottom))] md:pb-6">
        <div className="mx-auto flex max-w-[1440px] flex-col sm:flex-row items-center justify-between gap-4 px-4 sm:px-6 lg:px-8 text-xs text-slate-500 dark:text-slate-400">
          <p className="font-medium text-slate-700 dark:text-slate-300">CineBox Streaming Hub</p>
          <div className="flex items-center gap-6">
            <strong className="text-slate-800 dark:text-slate-200">Created By Sagar Ali</strong>
          </div>
        </div>
      </footer>

      <BottomNav
        activeTab={activeTab}
        activeDownloadCount={activeDownloadCount}
        onSelectTab={handleSelectTab}
      />

      <ReminderToastStack
        alerts={activeAlerts}
        onDismiss={(id) => setActiveAlerts((prev) => prev.filter((a) => a.id !== id))}
        onTuneIn={(target, reminderId) => {
          setActiveAlerts((prev) => prev.filter((a) => a.id !== reminderId));
          handleOpenDetail(target);
        }}
      />

      {remindersOpen && (
        <Suspense fallback={null}>
          <RemindersModal
            reminders={reminders}
            onClose={() => setRemindersOpen(false)}
            onOpenDetail={handleOpenDetail}
            onUpdateLeadTime={handleUpdateReminderLeadTime}
            onRemoveReminder={handleRemoveReminder}
            onClearReminders={handleClearReminders}
            onSendTestAlert={handleSendTestAlert}
          />
        </Suspense>
      )}

      {searchOpen && (
        <OmniSearchModal
          initialPerson={searchPerson}
          onClose={() => {
            setSearchOpen(false);
            setSearchPerson(null);
          }}
          onOpenDetail={handleOpenDetail}
        />
      )}

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            isOpen={settingsOpen}
            theme={theme}
            onToggleTheme={handleToggleTheme}
            onClose={() => setSettingsOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
