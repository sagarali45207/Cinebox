interface SpinnerLoaderProps {
  label?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function SpinnerLoader({
  label = 'Loading...',
  className = '',
  size = 'md',
}: SpinnerLoaderProps) {
  const isSm = size === 'sm';
  const isLg = size === 'lg';

  const containerSize = isSm ? 'h-7 w-7' : isLg ? 'h-14 w-14' : 'h-10 w-10';
  const trackBorder = isSm ? 'border-[2px]' : isLg ? 'border-[3px]' : 'border-[2.5px]';
  const centerOrbSize = isSm ? 'h-2 w-2' : isLg ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5';
  const textSize = isSm ? 'text-[11px]' : isLg ? 'text-sm' : 'text-xs';

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center gap-3.5 py-8 text-center select-none ${className}`}
    >
      <div className={`relative ${containerSize} flex items-center justify-center`}>
        <div
          className={`absolute inset-0 rounded-full ${trackBorder} border-white/[0.08]`}
        />
        <div
          className={`absolute inset-0 rounded-full ${trackBorder} border-transparent border-t-[#E11D48] animate-spin`}
          style={{ animationDuration: '0.8s' }}
        />
        <div className={`relative ${centerOrbSize} rounded-full bg-[#E11D48]`} />
      </div>

      {label && (
        <span className={`font-medium tracking-wide text-slate-300/90 ${textSize}`}>
          {label}
        </span>
      )}
    </div>
  );
}
