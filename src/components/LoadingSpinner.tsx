interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  label?: string;
  sublabel?: string;
  fullHeight?: boolean;
  tone?: 'auto' | 'dark';
  className?: string;
}

export function LoadingSpinner({
  size = 'md',
  label,
  sublabel,
  fullHeight = false,
  tone = 'auto',
  className = '',
}: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'h-4 w-4 border-2',
    md: 'h-8 w-8 border-[3px]',
    lg: 'h-12 w-12 border-4',
    xl: 'h-16 w-16 border-[4px]',
  }[size];

  const glowSizeClasses = {
    sm: 'h-6 w-6',
    md: 'h-11 w-11',
    lg: 'h-16 w-16',
    xl: 'h-22 w-22',
  }[size];

  const isDarkTone = tone === 'dark';

  return (
    <div
      className={`flex flex-col items-center justify-center gap-3.5 select-none ${
        fullHeight ? 'min-h-[220px] py-8' : ''
      } ${className}`}
    >
      <div className="relative flex items-center justify-center">
        {/* Track ring */}
        <div
          className={`rounded-full ${
            isDarkTone
              ? 'border-white/15'
              : 'border-slate-300/75 dark:border-white/12'
          } ${sizeClasses}`}
        />
        {/* Animated vibrant colorful spinner */}
        <div
          className={`absolute rounded-full border-transparent border-t-[#E11D48] border-r-indigo-500 border-b-sky-400 animate-spin ${sizeClasses}`}
          style={{ animationDuration: '0.78s' }}
        />
      </div>

      {(label || sublabel) && (
        <div className="text-center max-w-xs">
          {label && (
            <p
              className={`font-display text-sm font-semibold tracking-wide ${
                isDarkTone ? 'text-white' : 'text-slate-900 dark:text-white'
              }`}
            >
              {label}
            </p>
          )}
          {sublabel && (
            <p
              className={`mt-1 text-xs ${
                isDarkTone ? 'text-slate-300' : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {sublabel}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function PageLoader({
  label = 'Loading from streaming server...',
  sublabel,
  className = 'py-20 min-h-[360px]',
}: {
  label?: string;
  sublabel?: string;
  className?: string;
}) {
  return (
    <div className={`flex w-full flex-col items-center justify-center px-4 ${className}`}>
      <div className="relative rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#0F131D] p-8 shadow-lg max-w-sm w-full flex flex-col items-center text-center">
        <LoadingSpinner size="lg" label={label} sublabel={sublabel} />
      </div>
    </div>
  );
}

export function InlineLoader({
  label = 'Loading...',
  className = '',
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div className={`inline-flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300 ${className}`}>
      <div className="relative h-3.5 w-3.5 flex items-center justify-center">
        <div className="h-3.5 w-3.5 rounded-full border-2 border-slate-300 dark:border-white/20 border-t-[#E11D48] border-r-indigo-500 animate-spin" />
      </div>
      <span>{label}</span>
    </div>
  );
}
