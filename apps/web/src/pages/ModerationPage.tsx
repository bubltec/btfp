import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FieldChange, PendingContributionCard, User } from '@btfp/shared-types';
import { api } from '../lib/api.js';
import { isNonProdHost } from '../lib/env.js';
import { useCurrentUser } from '../lib/useCurrentUser.js';
import { EmailSignInDialog } from '../components/EmailSignInDialog.js';

type Confidence = 'high' | 'medium' | 'low' | 'unknown';
type ConfidenceFilter = 'all' | Confidence;

const CONFIDENCE_FILTERS: { id: ConfidenceFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
  { id: 'unknown', label: 'Unknown' },
];

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  high: 'bg-leaf-100 text-leaf-600',
  medium: 'bg-paw-100 text-paw-600',
  low: 'bg-alert-100 text-alert-600',
  unknown: 'bg-neutral-100 text-neutral-500',
};

function cardKey(item: PendingContributionCard): string {
  return item.SK ?? item.id ?? item.payload.name;
}

function cardConfidence(item: PendingContributionCard): Confidence {
  const raw = item.payload.details?.confidence;
  return raw === 'high' || raw === 'medium' || raw === 'low' ? raw : 'unknown';
}

function thingIdFromCard(item: PendingContributionCard): string {
  return item.PK!.replace('THING#', '');
}

const CHANGE_STYLE: Record<FieldChange['kind'], string> = {
  added: 'text-leaf-600',
  changed: 'text-paw-600',
  removed: 'text-alert-600',
};
const CHANGE_MARK: Record<FieldChange['kind'], string> = { added: '+', changed: '~', removed: '−' };

function ChangeList({ card }: { card: PendingContributionCard }) {
  const { preview } = card;
  return (
    <div className="mt-2 text-sm">
      {preview.mergesInto && (
        <p className="text-neutral-500">
          Matches existing entry{' '}
          <Link to={`/things/${preview.mergesInto.id}`} className="underline">
            {preview.mergesInto.name}
          </Link>
          ; approving merges into it.
        </p>
      )}
      {preview.targetMissing && (
        <p className="text-alert-600">
          The entry this edits no longer exists; approving creates a new one.
        </p>
      )}
      {preview.unavailable ? (
        <p className="text-neutral-400">Preview unavailable for this item.</p>
      ) : preview.changes.length === 0 ? (
        <p className="text-neutral-400">
          Nothing would change: the live entry already has these values, and existing values win.
        </p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {preview.changes.map((change, i) => (
            <li key={`${change.field}-${i}`} className={CHANGE_STYLE[change.kind]}>
              <span className="font-mono">{CHANGE_MARK[change.kind]}</span> {change.label}:{' '}
              {change.kind === 'changed' && (
                <>
                  <span className="line-through opacity-70">{change.before}</span> → {change.after}
                </>
              )}
              {change.kind === 'added' && change.after}
              {change.kind === 'removed' && <span className="line-through">{change.before}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SignInPrompt({ onSignedIn }: { onSignedIn: () => void }) {
  return (
    <div className="mt-6 text-center">
      <p className="text-neutral-500">Sign in to review the queue.</p>
      <div className="mt-4 flex flex-wrap justify-center gap-3">
        <EmailSignInDialog onSignedIn={onSignedIn} />
        <a
          href="/api/auth/github"
          className="rounded-full bg-paw-500 px-3 py-1 text-sm font-semibold text-white hover:bg-paw-600"
        >
          Sign in with GitHub
        </a>
      </div>
    </div>
  );
}

function ContributionsSection() {
  const [items, setItems] = useState<PendingContributionCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    api
      .listPendingContributions()
      .then((next) => {
        setItems(next);
        const keys = new Set(next.map(cardKey));
        setSelected((prev) => new Set([...prev].filter((key) => keys.has(key))));
      })
      .catch((err: unknown) => {
        setItems([]);
        setError(err instanceof Error ? err.message : 'Could not load pending contributions');
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  const counts = useMemo(() => {
    const next = { all: items.length, high: 0, medium: 0, low: 0, unknown: 0 };
    for (const item of items) next[cardConfidence(item)] += 1;
    return next;
  }, [items]);

  const visible = useMemo(
    () =>
      confidenceFilter === 'all'
        ? items
        : items.filter((item) => cardConfidence(item) === confidenceFilter),
    [items, confidenceFilter],
  );

  const selectedVisible = visible.filter((item) => selected.has(cardKey(item)));
  const allVisibleSelected = visible.length > 0 && selectedVisible.length === visible.length;

  function toggle(item: PendingContributionCard) {
    const key = cardKey(item);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const item of visible) next.add(cardKey(item));
      return next;
    });
  }

  function selectNoneVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const item of visible) next.delete(cardKey(item));
      return next;
    });
  }

  async function approve(item: PendingContributionCard) {
    await api.approveContribution(thingIdFromCard(item), item.SK!);
  }

  async function reject(item: PendingContributionCard) {
    await api.rejectContribution(thingIdFromCard(item), item.SK!);
  }

  async function runBatch(targets: PendingContributionCard[], action: 'approve' | 'reject') {
    if (targets.length === 0) return;
    if (action === 'reject') {
      const label =
        targets.length === 1 ? `"${targets[0]!.payload.name}"` : `${targets.length} selected items`;
      if (!window.confirm(`Reject ${label}? They will leave the queue.`)) return;
    }

    setError(null);
    const verb = action === 'approve' ? 'Approving' : 'Rejecting';
    const failed: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const item = targets[i]!;
      setBusy(`${verb} ${i + 1} of ${targets.length}…`);
      try {
        if (action === 'approve') await approve(item);
        else await reject(item);
      } catch (err: unknown) {
        failed.push(`${item.payload.name}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }
    setBusy(null);
    if (failed.length) setError(failed.join(' · '));
    load();
  }

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-bold text-neutral-800">Pending contributions</h2>
        {!loading && items.length > 0 && (
          <p className="text-sm text-neutral-500">
            {visible.length === items.length
              ? `${items.length} in queue`
              : `${visible.length} of ${items.length} shown`}
            {selectedVisible.length > 0 ? ` · ${selectedVisible.length} selected` : ''}
          </p>
        )}
      </div>
      {error && <p className="mt-4 text-sm text-alert-600">{error}</p>}
      {busy && <p className="mt-2 text-sm text-neutral-500">{busy}</p>}
      {loading ? (
        <p className="mt-4 text-neutral-400">Loading…</p>
      ) : items.length === 0 && !error ? (
        <p className="mt-4 text-neutral-400">Nothing pending. 🎉</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
              Confidence
            </span>
            {CONFIDENCE_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                aria-pressed={confidenceFilter === filter.id}
                onClick={() => setConfidenceFilter(filter.id)}
                className={`rounded-full px-3 py-1 text-sm font-semibold ${
                  confidenceFilter === filter.id
                    ? 'bg-paw-500 text-white'
                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                }`}
              >
                {filter.label} ({counts[filter.id]})
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={selectAllVisible}
              disabled={visible.length === 0 || allVisibleSelected || Boolean(busy)}
              className="rounded-full border border-paw-200 px-3 py-1.5 text-sm font-semibold text-neutral-700 hover:bg-paw-50 disabled:opacity-50"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={selectNoneVisible}
              disabled={selectedVisible.length === 0 || Boolean(busy)}
              className="rounded-full border border-paw-200 px-3 py-1.5 text-sm font-semibold text-neutral-700 hover:bg-paw-50 disabled:opacity-50"
            >
              Select none
            </button>
            <button
              type="button"
              onClick={() => runBatch(selectedVisible, 'approve')}
              disabled={selectedVisible.length === 0 || Boolean(busy)}
              className="rounded-full bg-leaf-400 px-4 py-1.5 text-sm font-semibold text-white hover:bg-leaf-600 disabled:opacity-50"
            >
              Approve selected
            </button>
            <button
              type="button"
              onClick={() => runBatch(selectedVisible, 'reject')}
              disabled={selectedVisible.length === 0 || Boolean(busy)}
              className="rounded-full bg-alert-100 px-4 py-1.5 text-sm font-semibold text-alert-600 hover:bg-alert-100/80 disabled:opacity-50"
            >
              Reject selected
            </button>
          </div>
          {visible.length === 0 ? (
            <p className="mt-4 text-neutral-400">No items match this confidence filter.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {visible.map((item) => {
                const key = cardKey(item);
                const checked = selected.has(key);
                const confidence = cardConfidence(item);
                return (
                  <li
                    key={key}
                    className={`rounded-cozy border bg-white p-4 ${
                      checked ? 'border-paw-400' : 'border-paw-200'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 accent-paw-500"
                        checked={checked}
                        disabled={Boolean(busy)}
                        onChange={() => toggle(item)}
                        aria-label={`Select ${item.payload.name}`}
                      />
                      <div className="min-w-0 flex-1">
                        {item.thingId ? (
                          <p className="text-xs font-semibold tracking-wide text-paw-500 uppercase">
                            Edit →{' '}
                            <Link to={`/things/${item.thingId}`} className="underline">
                              view live entry
                            </Link>
                          </p>
                        ) : (
                          <p className="text-xs font-semibold tracking-wide text-leaf-600 uppercase">
                            New entry
                          </p>
                        )}
                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                          <p className="font-semibold text-neutral-800">{item.payload.name}</p>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${CONFIDENCE_STYLE[confidence]}`}
                          >
                            {confidence}
                          </span>
                        </div>
                        <p className="text-sm text-neutral-500 capitalize">
                          {item.payload.thingTypeId}
                        </p>
                        <ChangeList card={item} />
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => runBatch([item], 'approve')}
                            className="rounded-full bg-leaf-400 px-4 py-1.5 text-sm font-semibold text-white hover:bg-leaf-600 disabled:opacity-50"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => runBatch([item], 'reject')}
                            className="rounded-full bg-alert-100 px-4 py-1.5 text-sm font-semibold text-alert-600 hover:bg-alert-100/80 disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function ProfessionalVerificationsSection() {
  const [items, setItems] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    api
      .listPendingProfessionalVerifications()
      .then(setItems)
      .catch((err: unknown) => {
        setItems([]);
        setError(err instanceof Error ? err.message : 'Could not load organization verifications');
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  async function review(user: User, approve: boolean) {
    if (!user.id) {
      setError('This verification is missing a user id and cannot be reviewed.');
      return;
    }
    try {
      const reason = approve ? undefined : (prompt('Rejection reason (optional):') ?? undefined);
      await api.reviewProfessionalVerification(user.id, approve, reason);
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Review failed');
    }
  }

  return (
    <section className="mt-10">
      <h2 className="text-xl font-bold text-neutral-800">Pending organization verifications</h2>
      {error && <p className="mt-4 text-sm text-alert-600">{error}</p>}
      {loading ? (
        <p className="mt-4 text-neutral-400">Loading…</p>
      ) : items.length === 0 && !error ? (
        <p className="mt-4 text-neutral-400">Nothing pending. 🎉</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((user) => (
            <li
              key={user.id || user.professional?.domain || user.providerAccountId}
              className="rounded-cozy border border-paw-200 bg-white p-4"
            >
              <p className="font-semibold text-neutral-800">
                {user.displayName || user.professional?.domain || 'Unknown organization'}
              </p>
              {user.professional?.domain && user.professional.domain !== user.displayName && (
                <p className="text-sm text-neutral-500">{user.professional.domain}</p>
              )}
              {user.professional?.orgClassification && (
                <p className="mt-1 text-xs text-neutral-400">
                  Bedrock guess: {user.professional.orgClassification.replaceAll('_', ' ')} —{' '}
                  {user.professional.orgClassificationReasoning}
                </p>
              )}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => review(user, true)}
                  className="rounded-full bg-leaf-400 px-4 py-1.5 text-sm font-semibold text-white hover:bg-leaf-600"
                >
                  Approve
                </button>
                <button
                  onClick={() => review(user, false)}
                  className="rounded-full bg-alert-100 px-4 py-1.5 text-sm font-semibold text-alert-600 hover:bg-alert-100/80"
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DevUnlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .unlockDevContributor()
      .then(() => {
        if (!cancelled) onUnlocked();
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not unlock moderation on dev');
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onUnlocked]);

  if (busy) {
    return <p className="mt-4 text-neutral-400">Unlocking moderation on this environment…</p>;
  }
  if (error) {
    return <p className="mt-4 text-sm text-alert-600">{error}</p>;
  }
  return null;
}

export function ModerationPage() {
  const { user, loading, refresh } = useCurrentUser();
  const needsDevUnlock = Boolean(user && !user.verifiedContributor && isNonProdHost());

  if (loading) {
    return <div className="mx-auto max-w-3xl px-4 py-10 text-neutral-400">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-bold text-neutral-800">Moderation queue</h1>
      {!user ? (
        <SignInPrompt onSignedIn={refresh} />
      ) : !user.verifiedContributor && !isNonProdHost() ? (
        <p className="mt-6 text-neutral-500">
          You&apos;re signed in, but only verified contributors can review the queue. Take the quiz
          from Add a thing first.
        </p>
      ) : (
        <div className="mt-6">
          {needsDevUnlock && <DevUnlock onUnlocked={refresh} />}
          <ContributionsSection key={user.verifiedContributor ? 'verified' : 'signed-in'} />
          {user.verifiedContributor && <ProfessionalVerificationsSection />}
        </div>
      )}
    </div>
  );
}
