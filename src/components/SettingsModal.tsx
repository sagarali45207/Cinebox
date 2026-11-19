import { useEffect, useState } from 'react';
import {
  KeyRound,
  Lock,
  Moon,
  Plus,
  RotateCcw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import type { AspectRatioMode, DownloadProfileMode, VideoQualityOption } from '../types/media';
import { setDownloadProfileMode } from '../utils/offlineManager';
import {
  clearRecentSearchesStorage,
  hashParentalPin,
  resetPlaybackAndSearchSettings,
  useAppSettings,
  useRecentSearchesCount,
  verifyParentalPin,
  type SubtitleLanguagePref,
} from '../utils/settings';

type SettingsTab = 'general' | 'parental';

interface SettingsModalProps {
  isOpen: boolean;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onClose: () => void;
}

const QUALITY_OPTIONS: Array<{ id: VideoQualityOption; label: string }> = [
  { id: 'auto', label: 'Auto (Direct)' },
  { id: '1080p', label: '1080p Full HD' },
  { id: '720p', label: '720p HD' },
  { id: '480p', label: '480p SD' },
  { id: '360p', label: '360p Saver' },
];

const ASPECT_OPTIONS: Array<{ id: AspectRatioMode; label: string }> = [
  { id: 'fit', label: 'Fit (Original)' },
  { id: 'fill', label: 'Fill (Crop)' },
  { id: 'stretch', label: 'Stretch' },
  { id: '16:9', label: '16:9 Widescreen' },
  { id: '4:3', label: '4:3 Classic' },
  { id: '21:9', label: '21:9 Cinema' },
];

const SUBTITLE_OPTIONS: Array<{ id: SubtitleLanguagePref; label: string }> = [
  { id: 'auto', label: 'Auto (English)' },
  { id: 'off', label: 'Off by default' },
  { id: 'English', label: 'English' },
  { id: 'Hindi', label: 'Hindi' },
  { id: 'Spanish', label: 'Spanish' },
  { id: 'Arabic', label: 'Arabic' },
  { id: 'Urdu', label: 'Urdu' },
];

function ToggleSwitch({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ${
        checked ? 'bg-[#E11D48]' : 'bg-slate-300 dark:bg-white/15'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </span>
  );
}

export function SettingsModal({
  isOpen,
  theme,
  onToggleTheme,
  onClose,
}: SettingsModalProps) {
  const {
    settings,
    updateSettings,
    unlockParentalSession,
    lockParentalSession,
    isParentalLocked,
  } = useAppSettings();
  const recentSearchesCount = useRecentSearchesCount();

  const [rendered, setRendered] = useState(isOpen);
  const [visible, setVisible] = useState(false);

  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null,
  );

  // Parental PIN states
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [unlockPinInput, setUnlockPinInput] = useState('');
  const [changePinMode, setChangePinMode] = useState(false);
  const [keywordInput, setKeywordInput] = useState('');

  // Smooth mount / slide-in & slide-out / unmount lifecycle
  useEffect(() => {
    if (isOpen) {
      setRendered(true);
      let frame1 = 0;
      let frame2 = 0;
      frame1 = window.requestAnimationFrame(() => {
        frame2 = window.requestAnimationFrame(() => {
          setVisible(true);
        });
      });
      return () => {
        window.cancelAnimationFrame(frame1);
        window.cancelAnimationFrame(frame2);
      };
    }

    setVisible(false);
    const timer = window.setTimeout(() => {
      setRendered(false);
      setNotice(null);
      setUnlockPinInput('');
      setNewPin('');
      setConfirmPin('');
      setChangePinMode(false);
    }, 280);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  // Escape key & background scroll lock while drawer is open
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, onClose]);

  if (!rendered) return null;

  const showNotice = (kind: 'success' | 'error', text: string) => {
    setNotice({ kind, text });
  };

  const handleEnableParental = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newPin.replace(/\D/g, '');
    if (clean.length !== 4) {
      showNotice('error', 'Please enter a 4-digit numeric PIN.');
      return;
    }
    if (clean !== confirmPin.replace(/\D/g, '')) {
      showNotice('error', 'PIN entries do not match.');
      return;
    }
    updateSettings((prev) => ({
      ...prev,
      parental: {
        ...prev.parental,
        enabled: true,
        pinHash: hashParentalPin(clean),
      },
    }));
    lockParentalSession();
    setNewPin('');
    setConfirmPin('');
    showNotice('success', 'Parental Control is now enabled and locked.');
  };

  const handleUnlockParental = (e: React.FormEvent) => {
    e.preventDefault();
    if (!verifyParentalPin(unlockPinInput, settings)) {
      showNotice('error', 'Incorrect PIN. Please try again.');
      return;
    }
    setUnlockPinInput('');
    unlockParentalSession();
    showNotice('success', 'Parental Control unlocked for this session.');
  };

  const handleChangePin = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newPin.replace(/\D/g, '');
    if (clean.length !== 4) {
      showNotice('error', 'New PIN must be 4 digits.');
      return;
    }
    if (clean !== confirmPin.replace(/\D/g, '')) {
      showNotice('error', 'New PIN entries do not match.');
      return;
    }
    updateSettings((prev) => ({
      ...prev,
      parental: {
        ...prev.parental,
        pinHash: hashParentalPin(clean),
      },
    }));
    setNewPin('');
    setConfirmPin('');
    setChangePinMode(false);
    showNotice('success', 'Parental Control PIN updated.');
  };

  const handleDisableParental = () => {
    updateSettings((prev) => ({
      ...prev,
      parental: {
        ...prev.parental,
        enabled: false,
      },
    }));
    lockParentalSession();
    setChangePinMode(false);
    showNotice('success', 'Parental Control disabled.');
  };

  const handleAddKeyword = (e: React.FormEvent) => {
    e.preventDefault();
    if (isParentalLocked) return;
    const kw = keywordInput.trim().toLowerCase();
    if (kw.length < 2) {
      showNotice('error', 'Enter a keyword with at least 2 characters.');
      return;
    }
    if (settings.parental.blockedKeywords.includes(kw)) {
      setKeywordInput('');
      return;
    }
    updateSettings((prev) => ({
      ...prev,
      parental: {
        ...prev.parental,
        blockedKeywords: [...prev.parental.blockedKeywords, kw].slice(0, 30),
      },
    }));
    setKeywordInput('');
  };

  const handleRemoveKeyword = (kw: string) => {
    if (isParentalLocked) return;
    updateSettings((prev) => ({
      ...prev,
      parental: {
        ...prev.parental,
        blockedKeywords: prev.parental.blockedKeywords.filter((k) => k !== kw),
      },
    }));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-0 z-50 flex justify-start"
    >
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 bg-black/65 transition-opacity duration-200 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* Left Slide-Over Sidebar Drawer */}
      <aside
        className={`relative z-10 flex h-dvh w-full max-w-[420px] flex-col border-r border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#0C0F17] shadow-[20px_0_50px_-15px_rgba(15,23,42,0.22)] dark:shadow-[20px_0_50px_-15px_rgba(0,0,0,0.75)] transform transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] will-change-transform ${
          visible ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Sticky Drawer Header */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-200/80 dark:border-white/[0.07] px-5 py-4 pt-[calc(1rem+env(safe-area-inset-top))]">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white truncate">
              Settings
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
              Playback preferences &amp; parental controls
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200/80 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.04] text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.08] hover:text-slate-900 dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* Segmented Navigation */}
        <div className="px-5 pt-4 pb-2">
          <div
            role="tablist"
            aria-label="Settings sections"
            className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200/80 dark:border-white/[0.06] bg-slate-100/90 dark:bg-[#131824] p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'general'}
              onClick={() => {
                setActiveTab('general');
                setNotice(null);
              }}
              className={`inline-flex min-h-[38px] items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
                activeTab === 'general'
                  ? 'bg-white dark:bg-[#1C2233] text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <SlidersHorizontal
                className={`h-3.5 w-3.5 shrink-0 ${
                  activeTab === 'general' ? 'text-[#E11D48]' : ''
                }`}
              />
              <span>General &amp; Playback</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'parental'}
              onClick={() => {
                setActiveTab('parental');
                setNotice(null);
              }}
              className={`inline-flex min-h-[38px] items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
                activeTab === 'parental'
                  ? 'bg-white dark:bg-[#1C2233] text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {isParentalLocked ? (
                <Lock
                  className={`h-3.5 w-3.5 shrink-0 ${
                    activeTab === 'parental' ? 'text-amber-500' : 'text-amber-500/80'
                  }`}
                />
              ) : (
                <Shield
                  className={`h-3.5 w-3.5 shrink-0 ${
                    activeTab === 'parental' ? 'text-[#E11D48]' : ''
                  }`}
                />
              )}
              <span>Parental Control</span>
            </button>
          </div>
        </div>

        {/* Inline Status Notice */}
        {notice && (
          <div
            role="status"
            className={`mx-5 mt-2 flex items-center justify-between gap-2.5 rounded-xl border px-3.5 py-2.5 text-xs font-medium ${
              notice.kind === 'success'
                ? 'border-emerald-300/80 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/35 text-emerald-800 dark:text-emerald-200'
                : 'border-rose-300/80 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-950/35 text-rose-800 dark:text-rose-200'
            }`}
          >
            <span>{notice.text}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss notification"
              className="shrink-0 opacity-70 hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {activeTab === 'general' && (
            <>
              {/* Appearance */}
              <section className="space-y-2.5">
                <h3 className="px-1 text-xs font-semibold text-slate-500 dark:text-slate-400">
                  Appearance
                </h3>
                <div className="rounded-2xl border border-slate-200/85 dark:border-white/[0.07] bg-slate-50/65 dark:bg-[#111521]">
                  <div className="flex items-center justify-between gap-3 px-4 py-3.5 min-h-[60px]">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-white">
                        Interface Theme
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Switch between light and dark surface
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#090B10] p-1">
                      <button
                        type="button"
                        onClick={() => {
                          if (theme !== 'light') onToggleTheme();
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors ${
                          theme === 'light'
                            ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                        }`}
                      >
                        <Sun className="h-3.5 w-3.5" />
                        <span>Light</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (theme !== 'dark') onToggleTheme();
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors ${
                          theme === 'dark'
                            ? 'bg-white text-slate-900 shadow-sm'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                        }`}
                      >
                        <Moon className="h-3.5 w-3.5" />
                        <span>Dark</span>
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              {/* Media Player */}
              <section className="space-y-2.5">
                <h3 className="px-1 text-xs font-semibold text-slate-500 dark:text-slate-400">
                  Media Player
                </h3>
                <div className="divide-y divide-slate-200/75 dark:divide-white/[0.06] rounded-2xl border border-slate-200/85 dark:border-white/[0.07] bg-slate-50/65 dark:bg-[#111521]">
                  {/* Default Quality */}
                  <div className="flex items-center justify-between gap-3 px-4 py-3.5 min-h-[60px]">
                    <label
                      htmlFor="setting-default-quality"
                      className="min-w-0 cursor-pointer"
                    >
                      <span className="block text-sm font-medium text-slate-900 dark:text-white">
                        Default Quality
                      </span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        Stream resolution on start
                      </span>
                    </label>
                    <select
                      id="setting-default-quality"
                      value={settings.defaultQuality}
                      onChange={(e) =>
                        updateSettings({
                          defaultQuality: e.target.value as VideoQualityOption,
                        })
                      }
                      className="h-9 w-[142px] shrink-0 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#090B10] px-2.5 text-xs font-medium text-slate-900 dark:text-white focus:border-[#E11D48] focus:outline-none"
                    >
                      {QUALITY_OPTIONS.map((q) => (
                        <option key={q.id} value={q.id}>
                          {q.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Default Aspect Ratio */}
                  <div className="flex items-center justify-between gap-3 px-4 py-3.5 min-h-[60px]">
                    <label
                      htmlFor="setting-default-aspect"
                      className="min-w-0 cursor-pointer"
                    >
                      <span className="block text-sm font-medium text-slate-900 dark:text-white">
                        Aspect Ratio
                      </span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        Default video framing mode
                      </span>
                    </label>
                    <select
                      id="setting-default-aspect"
                      value={settings.defaultAspectRatio}
                      onChange={(e) =>
                        updateSettings({
                          defaultAspectRatio: e.target.value as AspectRatioMode,
                        })
                      }
                      className="h-9 w-[142px] shrink-0 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#090B10] px-2.5 text-xs font-medium text-slate-900 dark:text-white focus:border-[#E11D48] focus:outline-none"
                    >
                      {ASPECT_OPTIONS.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Preferred Subtitle Language */}
                  <div className="flex items-center justify-between gap-3 px-4 py-3.5 min-h-[60px]">
                    <label
                      htmlFor="setting-subtitle-lang"
                      className="min-w-0 cursor-pointer"
                    >
                      <span className="block text-sm font-medium text-slate-900 dark:text-white">
                        Subtitles
                      </span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        Preferred VOD track language
                      </span>
                    </label>
                    <select
                      id="setting-subtitle-lang"
                      value={settings.preferredSubtitleLang}
                      onChange={(e) =>
                        updateSettings({
                          preferredSubtitleLang: e.target.value as SubtitleLanguagePref,
                        })
                      }
                      className="h-9 w-[142px] shrink-0 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#090B10] px-2.5 text-xs font-medium text-slate-900 dark:text-white focus:border-[#E11D48] focus:outline-none"
                    >
                      {SUBTITLE_OPTIONS.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Auto-Play When Opening Title */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.autoPlayOnOpen}
                    onClick={() =>
                      updateSettings({ autoPlayOnOpen: !settings.autoPlayOnOpen })
                    }
                    className="flex w-full items-center justify-between gap-4 px-4 py-3.5 min-h-[60px] text-left hover:bg-slate-100/70 dark:hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-white">
                        Auto-Play on Open
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Start stream automatically when opening a title
                      </p>
                    </div>
                    <ToggleSwitch checked={settings.autoPlayOnOpen} />
                  </button>

                  {/* Keep Screen Awake */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.keepScreenAwake}
                    onClick={() =>
                      updateSettings({ keepScreenAwake: !settings.keepScreenAwake })
                    }
                    className="flex w-full items-center justify-between gap-4 px-4 py-3.5 min-h-[60px] text-left hover:bg-slate-100/70 dark:hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-white">
                        Keep Screen Awake
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Prevent device sleep while player is active
                      </p>
                    </div>
                    <ToggleSwitch checked={settings.keepScreenAwake} />
                  </button>

                  {/* Native Download Profile (Free vs Premium Concurrency) */}
                  <div className="flex items-center justify-between gap-3 px-4 py-3.5 min-h-[60px]">
                    <label
                      htmlFor="setting-download-profile"
                      className="min-w-0 cursor-pointer"
                    >
                      <span className="block text-sm font-medium text-slate-900 dark:text-white">
                        Download Engine Profile
                      </span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        {settings.downloadProfile === 'premium'
                          ? 'Higher bounded connections & priority queue'
                          : 'Conservative connections & balanced battery usage'}
                      </span>
                    </label>
                    <select
                      id="setting-download-profile"
                      value={settings.downloadProfile}
                      onChange={(e) => {
                        const next = e.target.value as DownloadProfileMode;
                        void setDownloadProfileMode(next);
                      }}
                      className="h-9 w-[142px] shrink-0 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#090B10] px-2.5 text-xs font-medium text-slate-900 dark:text-white focus:border-[#E11D48] focus:outline-none"
                    >
                      <option value="free">Standard (Free)</option>
                      <option value="premium">Turbo (Premium)</option>
                    </select>
                  </div>
                </div>
              </section>

              {/* Search & Privacy */}
              <section className="space-y-2.5">
                <h3 className="px-1 text-xs font-semibold text-slate-500 dark:text-slate-400">
                  Search &amp; Privacy
                </h3>
                <div className="divide-y divide-slate-200/75 dark:divide-white/[0.06] rounded-2xl border border-slate-200/85 dark:border-white/[0.07] bg-slate-50/65 dark:bg-[#111521]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.saveSearchHistory}
                    onClick={() =>
                      updateSettings({ saveSearchHistory: !settings.saveSearchHistory })
                    }
                    className="flex w-full items-center justify-between gap-4 px-4 py-3.5 min-h-[60px] text-left hover:bg-slate-100/70 dark:hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-white">
                        Save Recent Searches
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Keep recent terms for quick Omni-Search access
                      </p>
                    </div>
                    <ToggleSwitch checked={settings.saveSearchHistory} />
                  </button>

                  <div className="flex items-center justify-between gap-3 px-4 py-3.5 min-h-[60px]">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-white tabular-nums">
                        Recent Searches ({recentSearchesCount})
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Clear stored search terms on this device
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={recentSearchesCount === 0}
                      onClick={() => {
                        clearRecentSearchesStorage();
                        showNotice('success', 'Recent searches cleared.');
                      }}
                      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-white/[0.04] px-3 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-rose-300 hover:text-[#E11D48] disabled:opacity-45 whitespace-nowrap transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Clear</span>
                    </button>
                  </div>
                </div>

                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      resetPlaybackAndSearchSettings();
                      showNotice('success', 'Playback & search settings restored to defaults.');
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.05] hover:text-slate-900 dark:hover:text-white whitespace-nowrap transition-colors"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Reset playback defaults</span>
                  </button>
                </div>
              </section>
            </>
          )}

          {activeTab === 'parental' && (
            <div className="space-y-6">
              {/* PIN Control Card */}
              {!settings.parental.enabled ? (
                <form
                  onSubmit={handleEnableParental}
                  className="rounded-2xl border border-slate-200/85 dark:border-white/[0.07] bg-slate-50/70 dark:bg-[#111521] p-4 space-y-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#E11D48]/10 text-[#E11D48]">
                      <Shield className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                        Set Up Parental PIN
                      </h3>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                        Create a 4-digit PIN to hide adult channels, mature genres, and blocked keywords.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="parental-new-pin"
                        className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5"
                      >
                        4-Digit PIN
                      </label>
                      <input
                        id="parental-new-pin"
                        type="password"
                        inputMode="numeric"
                        maxLength={4}
                        value={newPin}
                        onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        placeholder="••••"
                        className="h-10 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#090B10] px-3 text-center font-mono text-sm tracking-[0.35em] text-slate-900 dark:text-white focus:border-[#E11D48] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="parental-confirm-pin"
                        className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5"
                      >
                        Confirm PIN
                      </label>
                      <input
                        id="parental-confirm-pin"
                        type="password"
                        inputMode="numeric"
                        maxLength={4}
                        value={confirmPin}
                        onChange={(e) =>
                          setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))
                        }
                        placeholder="••••"
                        className="h-10 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#090B10] px-3 text-center font-mono text-sm tracking-[0.35em] text-slate-900 dark:text-white focus:border-[#E11D48] focus:outline-none"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[#E11D48] px-4 text-xs font-semibold text-white hover:bg-[#BE123C] transition-colors"
                  >
                    <Lock className="h-3.5 w-3.5" />
                    <span>Enable Parental Control</span>
                  </button>
                </form>
              ) : isParentalLocked ? (
                <form
                  onSubmit={handleUnlockParental}
                  className="rounded-2xl border border-amber-300/80 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-950/20 p-4 space-y-3.5"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
                      <ShieldAlert className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                        Parental Control Locked
                      </h3>
                      <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                        Enter your 4-digit PIN to change filters or unlock for this session.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      inputMode="numeric"
                      maxLength={4}
                      value={unlockPinInput}
                      onChange={(e) =>
                        setUnlockPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))
                      }
                      aria-label="Enter 4-digit Parental Control PIN"
                      placeholder="••••"
                      className="h-10 w-28 shrink-0 rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-[#090B10] px-3 text-center font-mono text-sm tracking-[0.35em] text-slate-900 dark:text-white focus:border-[#E11D48] focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-slate-900 dark:bg-white px-4 text-xs font-semibold text-white dark:text-slate-900 hover:opacity-90 whitespace-nowrap transition-opacity"
                    >
                      <Unlock className="h-3.5 w-3.5" />
                      <span>Unlock</span>
                    </button>
                  </div>
                </form>
              ) : (
                <div className="rounded-2xl border border-emerald-300/80 dark:border-emerald-500/30 bg-emerald-50/70 dark:bg-emerald-950/20 p-4 space-y-3.5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                      <ShieldCheck className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                        Unlocked for Session
                      </h3>
                      <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                        Protection automatically re-locks when you restart the app.
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        lockParentalSession();
                        showNotice('success', 'Parental Control locked.');
                      }}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-white px-3 text-xs font-semibold text-white dark:text-slate-900 hover:opacity-90 whitespace-nowrap"
                    >
                      <Lock className="h-3.5 w-3.5" />
                      <span>Lock Now</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setChangePinMode((v) => !v)}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-white/10 px-3 text-xs font-semibold text-slate-700 dark:text-white whitespace-nowrap"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      <span>Change PIN</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleDisableParental}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-rose-300/80 dark:border-rose-500/40 bg-white dark:bg-rose-950/30 px-3 text-xs font-semibold text-rose-600 dark:text-rose-300 hover:bg-rose-50 whitespace-nowrap"
                    >
                      <span>Disable</span>
                    </button>
                  </div>

                  {changePinMode && (
                    <form
                      onSubmit={handleChangePin}
                      className="grid grid-cols-2 gap-2 border-t border-emerald-200/80 dark:border-emerald-500/25 pt-3"
                    >
                      <input
                        type="password"
                        inputMode="numeric"
                        maxLength={4}
                        value={newPin}
                        onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        placeholder="New PIN"
                        className="h-9 rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-[#090B10] px-2.5 text-center font-mono text-xs tracking-[0.25em] text-slate-900 dark:text-white focus:border-[#E11D48] focus:outline-none"
                      />
                      <input
                        type="password"
                        inputMode="numeric"
                        maxLength={4}
                        value={confirmPin}
                        onChange={(e) =>
                          setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))
                        }
                        placeholder="Confirm"
                        className="h-9 rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-[#090B10] px-2.5 text-center font-mono text-xs tracking-[0.25em] text-slate-900 dark:text-white focus:border-[#E11D48] focus:outline-none"
                      />
                      <button
                        type="submit"
                        className="col-span-2 h-9 rounded-lg bg-[#E11D48] px-4 text-xs font-semibold text-white hover:bg-[#BE123C]"
                      >
                        Save New PIN
                      </button>
                    </form>
                  )}
                </div>
              )}

              {/* Content Filters */}
              <section className="space-y-2.5">
                <h3 className="px-1 text-xs font-semibold text-slate-500 dark:text-slate-400">
                  Content Filters
                </h3>

                <div
                  className={`divide-y divide-slate-200/75 dark:divide-white/[0.06] rounded-2xl border border-slate-200/85 dark:border-white/[0.07] bg-slate-50/65 dark:bg-[#111521] ${
                    isParentalLocked ? 'opacity-60 pointer-events-none' : ''
                  }`}
                >
                  <button
                    type="button"
                    role="switch"
                    disabled={isParentalLocked}
                    aria-checked={settings.parental.blockAdult}
                    onClick={() =>
                      updateSettings((prev) => ({
                        ...prev,
                        parental: {
                          ...prev.parental,
                          blockAdult: !prev.parental.blockAdult,
                        },
                      }))
                    }
                    className="flex w-full items-center justify-between gap-4 px-4 py-3.5 min-h-[60px] text-left hover:bg-slate-100/70 dark:hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-white">
                        Hide Adult / 18+ Channels
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Filters explicit 18+, XXX &amp; adult categories
                      </p>
                    </div>
                    <ToggleSwitch checked={settings.parental.blockAdult} />
                  </button>

                  <button
                    type="button"
                    role="switch"
                    disabled={isParentalLocked}
                    aria-checked={settings.parental.kidsMode}
                    onClick={() =>
                      updateSettings((prev) => ({
                        ...prev,
                        parental: {
                          ...prev.parental,
                          kidsMode: !prev.parental.kidsMode,
                        },
                      }))
                    }
                    className="flex w-full items-center justify-between gap-4 px-4 py-3.5 min-h-[60px] text-left hover:bg-slate-100/70 dark:hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-white">
                        Kids &amp; Family Safe Mode
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Hides Horror, Crime, Thriller &amp; mature titles
                      </p>
                    </div>
                    <ToggleSwitch checked={settings.parental.kidsMode} />
                  </button>

                  <div className="px-4 py-3.5 space-y-3">
                    <div>
                      <p className="text-sm font-medium text-slate-900 dark:text-white">
                        Blocked Keywords
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Hide titles or categories containing these words
                      </p>
                    </div>

                    <form onSubmit={handleAddKeyword} className="flex gap-2">
                      <input
                        type="text"
                        disabled={isParentalLocked}
                        value={keywordInput}
                        onChange={(e) => setKeywordInput(e.target.value)}
                        placeholder="Add keyword..."
                        className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#090B10] px-3 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-[#E11D48] focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={isParentalLocked}
                        className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg bg-slate-900 dark:bg-white px-3 text-xs font-semibold text-white dark:text-slate-900 hover:opacity-90 whitespace-nowrap"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>Block</span>
                      </button>
                    </form>

                    {settings.parental.blockedKeywords.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {settings.parental.blockedKeywords.map((kw) => (
                          <button
                            key={kw}
                            type="button"
                            disabled={isParentalLocked}
                            onClick={() => handleRemoveKeyword(kw)}
                            aria-label={`Remove blocked keyword ${kw}`}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-[#090B10] px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-rose-300 hover:text-[#E11D48]"
                          >
                            <span>{kw}</span>
                            <X className="h-3 w-3 opacity-65" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>

        {/* Brief About App Footer */}
        <footer className="border-t border-slate-200/80 dark:border-white/[0.07] bg-slate-50/85 dark:bg-[#090C13] px-5 py-3.5 pb-[calc(0.875rem+env(safe-area-inset-bottom))]">
          <div className="flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-display text-sm font-bold tracking-tight cinebox-brand-gradient">
                CineBox
              </span>
              <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">
                ·
              </span>
              <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                v1.0.0
              </span>
            </div>
            <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">
              Created By Sagar Ali
            </span>
          </div>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 truncate">
            Movies, Series, Live TV, Offline Downloads &amp; Interactive EPG.
          </p>
        </footer>
      </aside>
    </div>
  );
}
