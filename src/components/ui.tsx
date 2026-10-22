'use client';



export function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-10 h-10 border-4 border-[var(--border)] border-t-[var(--primary)] rounded-full animate-spin" />
    </div>
  );
}

// ─── Skeleton-загрузки (вместо спиннеров на сетках/полках) ───────────────
export function SkeletonCard({ aspect = 'aspect-[3/4]' }: { aspect?: string }) {
  return (
    <div className={`rounded-xl overflow-hidden bg-[var(--card)] border border-[var(--border)] ${aspect} animate-pulse`}>
      <div className="w-full h-full bg-[var(--muted)]" />
    </div>
  );
}

export function SkeletonGrid({ count = 12, cols = 'grid-cols-3 md:grid-cols-4 lg:grid-cols-6', aspect = 'aspect-[3/4]', gap = 'gap-2.5 sm:gap-4' }: {
  count?: number; cols?: string; aspect?: string; gap?: string;
}) {
  return (
    <div className={`grid ${cols} ${gap}`}>
      {Array.from({ length: count }, (_, i) => <SkeletonCard key={i} aspect={aspect} />)}
    </div>
  );
}

export function SkeletonLine({ className = '' }: { className?: string }) {
  return <div className={`rounded bg-[var(--muted)] animate-pulse ${className}`} />;
}
