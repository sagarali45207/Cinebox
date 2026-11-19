import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, MessageSquarePlus, Pencil, Star, Trash2, X } from 'lucide-react';
import type { MediaReview } from '../types/media';
import { formatRelativeTime } from '../utils/format';
import {
  deleteMediaReview,
  getMediaReviews,
  getSavedReviewerName,
  saveMediaReview,
  saveReviewerName,
} from '../utils/storage';

interface MediaReviewsSectionProps {
  kind: 'movie' | 'series';
  mediaId: string;
  mediaTitle: string;
  catalogRating?: number;
}

type ReviewSort = 'newest' | 'highest' | 'lowest';

const RATING_LABELS: Record<number, string> = {
  1: 'Poor',
  2: 'Fair',
  3: 'Good',
  4: 'Very Good',
  5: 'Masterpiece',
};

const MAX_COMMENT_LENGTH = 500;

export function MediaReviewsSection({
  kind,
  mediaId,
  mediaTitle,
  catalogRating,
}: MediaReviewsSectionProps) {
  const mediaKey = `${kind}:${mediaId}`;

  const [reviews, setReviews] = useState<MediaReview[]>(() => getMediaReviews(mediaKey));
  const [rating, setRating] = useState<number>(0);
  const [hoverRating, setHoverRating] = useState<number>(0);
  const [author, setAuthor] = useState<string>(() => getSavedReviewerName());
  const [comment, setComment] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<ReviewSort>('newest');
  const [formError, setFormError] = useState<string>('');
  const [savedNotice, setSavedNotice] = useState<boolean>(false);

  // Sync reviews when navigating between titles
  useEffect(() => {
    setReviews(getMediaReviews(mediaKey));
    setRating(0);
    setHoverRating(0);
    setComment('');
    setEditingId(null);
    setConfirmDeleteId(null);
    setFormError('');
    setSavedNotice(false);
  }, [mediaKey]);

  const stats = useMemo(() => {
    const count = reviews.length;
    const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
    const average = count > 0 ? sum / count : 0;
    const distribution = [5, 4, 3, 2, 1].map((stars) => {
      const n = reviews.filter((r) => r.rating === stars).length;
      return {
        stars,
        count: n,
        pct: count > 0 ? Math.round((n / count) * 100) : 0,
      };
    });
    return { count, average, distribution };
  }, [reviews]);

  const sortedReviews = useMemo(() => {
    const list = [...reviews];
    if (sortBy === 'highest') {
      return list.sort(
        (a, b) => b.rating - a.rating || (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt),
      );
    }
    if (sortBy === 'lowest') {
      return list.sort(
        (a, b) => a.rating - b.rating || (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt),
      );
    }
    return list.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }, [reviews, sortBy]);

  const displayRating = hoverRating || rating;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (rating < 1 || rating > 5) {
      setFormError('Select a star rating from 1 to 5 before submitting.');
      return;
    }

    const next = saveMediaReview({
      id: editingId || undefined,
      mediaKey,
      kind,
      mediaId,
      mediaTitle,
      author,
      rating,
      comment,
    });
    saveReviewerName(author);

    setReviews(next);
    setRating(0);
    setHoverRating(0);
    setComment('');
    setEditingId(null);
    setFormError('');
    setSavedNotice(true);
    window.setTimeout(() => setSavedNotice(false), 2600);
  }

  function handleStartEdit(review: MediaReview) {
    setEditingId(review.id);
    setRating(review.rating);
    setHoverRating(0);
    setAuthor(review.author === 'Viewer' ? '' : review.author);
    setComment(review.comment);
    setConfirmDeleteId(null);
    setFormError('');
  }

  function handleCancelEdit() {
    setEditingId(null);
    setRating(0);
    setHoverRating(0);
    setComment('');
    setAuthor(getSavedReviewerName());
    setFormError('');
  }

  function handleDelete(reviewId: string) {
    const next = deleteMediaReview(mediaKey, reviewId);
    setReviews(next);
    setConfirmDeleteId(null);
    if (editingId === reviewId) {
      handleCancelEdit();
    }
  }

  return (
    <section
      aria-label="Ratings and Reviews"
      className="border-t border-slate-200/80 dark:border-white/[0.08] pt-8"
    >
      {/* Section Header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
            Ratings &amp; Reviews
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {stats.count > 0 ? (
              <>
                <span className="inline-flex items-center gap-1 font-semibold text-amber-600 dark:text-amber-400">
                  <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                  <span>{stats.average.toFixed(1)} / 5</span>
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {stats.count} {stats.count === 1 ? 'viewer review' : 'viewer reviews'}
                </span>
              </>
            ) : (
              <span>Be the first to rate and review {mediaTitle}</span>
            )}
            {typeof catalogRating === 'number' && catalogRating > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>Catalog score ★ {catalogRating.toFixed(1)}</span>
              </>
            )}
          </p>
        </div>

        {reviews.length > 1 && (
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-1 shadow-sm shadow-slate-900/5 dark:shadow-none">
            {(
              [
                { id: 'newest', label: 'Newest' },
                { id: 'highest', label: 'Highest' },
                { id: 'lowest', label: 'Lowest' },
              ] as Array<{ id: ReviewSort; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSortBy(tab.id)}
                className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                  sortBy === tab.id
                    ? 'bg-[#E11D48] text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Breakdown + Review Composer */}
        <div className="lg:col-span-5 space-y-5">
          {stats.count > 0 && (
            <div className="rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-4 sm:p-5 shadow-sm shadow-slate-900/5 dark:shadow-none">
              <div className="flex items-center gap-4 pb-4 border-b border-slate-100 dark:border-white/[0.06]">
                <div className="text-center shrink-0 pr-2">
                  <p className="font-display text-3xl font-bold text-slate-900 dark:text-white tabular-nums">
                    {stats.average.toFixed(1)}
                  </p>
                  <div className="mt-1 flex items-center justify-center gap-0.5">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star
                        key={n}
                        className={`h-3 w-3 ${
                          n <= Math.round(stats.average)
                            ? 'fill-amber-400 text-amber-400'
                            : 'text-slate-300 dark:text-slate-600'
                        }`}
                      />
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                    {stats.count} {stats.count === 1 ? 'rating' : 'ratings'}
                  </p>
                </div>

                <div className="flex-1 space-y-1.5">
                  {stats.distribution.map((row) => (
                    <div
                      key={row.stars}
                      className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-400 tabular-nums"
                    >
                      <span className="w-6 text-right font-medium">{row.stars}★</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.06]">
                        <div
                          className="h-full rounded-full bg-amber-400 transition-[width] duration-300"
                          style={{ width: `${row.pct}%` }}
                        />
                      </div>
                      <span className="w-6 text-right text-slate-500 dark:text-slate-400">
                        {row.count}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-4 sm:p-5 shadow-sm shadow-slate-900/5 dark:shadow-none space-y-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                <MessageSquarePlus className="h-4 w-4 text-[#E11D48]" />
                <span>{editingId ? 'Edit Your Review' : 'Write a Review'}</span>
              </h3>
              {savedNotice && !editingId && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                  <Check className="h-3.5 w-3.5" />
                  <span>Saved</span>
                </span>
              )}
            </div>

            {/* Interactive Star Picker */}
            <div>
              <span className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">
                Your Rating
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <div
                  className="inline-flex items-center gap-1"
                  onMouseLeave={() => setHoverRating(0)}
                >
                  {[1, 2, 3, 4, 5].map((starVal) => {
                    const active = starVal <= displayRating;
                    return (
                      <button
                        key={starVal}
                        type="button"
                        onClick={() => {
                          setRating(starVal);
                          if (formError) setFormError('');
                        }}
                        onMouseEnter={() => setHoverRating(starVal)}
                        aria-label={`Rate ${starVal} out of 5 stars`}
                        aria-pressed={rating === starVal}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-lg transition-transform duration-150 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
                      >
                        <Star
                          className={`h-6 w-6 transition-colors ${
                            active
                              ? 'fill-amber-400 text-amber-400'
                              : 'text-slate-300 dark:text-slate-600 hover:text-amber-300'
                          }`}
                        />
                      </button>
                    );
                  })}
                </div>
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 tabular-nums">
                  {displayRating > 0
                    ? `${displayRating}/5 · ${RATING_LABELS[displayRating]}`
                    : 'Tap a star to rate'}
                </span>
              </div>
            </div>

            <div>
              <label
                htmlFor="cinebox-review-author"
                className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5"
              >
                Display Name <span className="text-slate-400 dark:text-slate-500">(optional)</span>
              </label>
              <input
                id="cinebox-review-author"
                type="text"
                maxLength={40}
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="Viewer"
                className="h-10 w-full rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-[#090B10] px-3 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-[#E11D48] focus:outline-none"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="cinebox-review-comment"
                  className="text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  Review Comment{' '}
                  <span className="text-slate-400 dark:text-slate-500">(optional)</span>
                </label>
                <span className="text-[11px] text-slate-400 dark:text-slate-500 tabular-nums">
                  {comment.length}/{MAX_COMMENT_LENGTH}
                </span>
              </div>
              <textarea
                id="cinebox-review-comment"
                rows={3}
                maxLength={MAX_COMMENT_LENGTH}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={`Share your thoughts on ${mediaTitle}...`}
                className="w-full resize-y rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-[#090B10] px-3 py-2.5 text-sm leading-relaxed text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-[#E11D48] focus:outline-none"
              />
            </div>

            {formError && (
              <p role="alert" className="text-xs font-medium text-rose-600 dark:text-rose-400">
                {formError}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              <button
                type="submit"
                className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-[#E11D48] px-5 text-xs sm:text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#BE123C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
              >
                {editingId ? 'Update Review' : 'Post Review'}
              </button>

              {editingId && (
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 px-4 text-xs sm:text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>Cancel</span>
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Right Column: Reviews List */}
        <div className="lg:col-span-7 space-y-3">
          {sortedReviews.length === 0 ? (
            <div className="rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] px-6 py-12 text-center shadow-sm shadow-slate-900/5 dark:shadow-none">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 dark:bg-white/[0.06] text-amber-500">
                <Star className="h-5 w-5" />
              </div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                No viewer reviews yet
              </h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                Rate {mediaTitle} using the star picker to keep track of favorites and share your notes.
              </p>
            </div>
          ) : (
            sortedReviews.map((rev) => {
              const initials = rev.author
                .split(/\s+/)
                .filter(Boolean)
                .map((p) => p[0])
                .slice(0, 2)
                .join('')
                .toUpperCase();
              const isEditingThis = editingId === rev.id;
              const isConfirmingDelete = confirmDeleteId === rev.id;

              return (
                <article
                  key={rev.id}
                  className={`rounded-xl border p-4 sm:p-5 transition-colors shadow-sm shadow-slate-900/5 dark:shadow-none ${
                    isEditingThis
                      ? 'border-[#E11D48]/60 bg-rose-50/40 dark:border-rose-500/50 dark:bg-rose-500/[0.06]'
                      : 'border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#E11D48] text-xs font-bold text-white">
                        {initials || 'V'}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                          {rev.author}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                          <span className="inline-flex items-center gap-0.5">
                            {[1, 2, 3, 4, 5].map((n) => (
                              <Star
                                key={n}
                                className={`h-3 w-3 ${
                                  n <= rev.rating
                                    ? 'fill-amber-400 text-amber-400'
                                    : 'text-slate-300 dark:text-slate-600'
                                }`}
                              />
                            ))}
                          </span>
                          <span className="font-semibold text-slate-700 dark:text-slate-300">
                            {rev.rating}.0
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{formatRelativeTime(rev.updatedAt || rev.createdAt)}</span>
                          {rev.updatedAt && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>Edited</span>
                            </>
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleStartEdit(rev)}
                        aria-label={`Edit review by ${rev.author}`}
                        title="Edit review"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.04] text-slate-500 dark:text-slate-400 hover:border-indigo-300 hover:text-indigo-600 dark:hover:border-white/25 dark:hover:text-white transition-colors"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>

                      {isConfirmingDelete ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleDelete(rev.id)}
                            className="inline-flex h-8 items-center rounded-lg bg-rose-600 px-2.5 text-xs font-semibold text-white hover:bg-rose-700 transition-colors whitespace-nowrap"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            aria-label="Cancel delete"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(rev.id)}
                          aria-label={`Delete review by ${rev.author}`}
                          title="Delete review"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.04] text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {rev.comment ? (
                    <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300 whitespace-pre-line">
                      {rev.comment}
                    </p>
                  ) : (
                    <p className="mt-2.5 text-xs italic text-slate-400 dark:text-slate-500">
                      Rated {rev.rating} out of 5 stars
                    </p>
                  )}
                </article>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
