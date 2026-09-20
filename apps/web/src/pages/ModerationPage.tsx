import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { User } from '@btfp/shared-types';
import { api } from '../lib/api.js';
import { isNonProdHost } from '../lib/env.js';
import { useCurrentUser } from '../lib/useCurrentUser.js';
import { EmailSignInDialog } from '../components/EmailSignInDialog.js';

interface PendingContribution {
  PK: string;
  SK: string;
  thingId?: string;
  contributorId: string;
  payload: { name?: string; thingTypeId?: string };
  createdAt: string;
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
  const [items, setItems] = useState<PendingContribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    api
      .listPendingContributions()
      .then((data) => setItems(data as PendingContribution[]))
      .catch((err: unknown) => {
        setItems([]);
        setError(err instanceof Error ? err.message : 'Could not load pending contributions');
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  async function approve(item: PendingContribution) {
    const thingId = item.PK.replace('THING#', '');
    try {
      const res = await fetch(
        `/api/contributions/${thingId}/${encodeURIComponent(item.SK)}/approve`,
        {
          method: 'POST',
          credentials: 'include',
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({ message: undefined }))) as {
          message?: string;
        };
        throw new Error(body.message ?? `Approve failed: ${res.status}`);
      }
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Approve failed');
    }
  }

  return (
    <section>
      <h2 className="text-xl font-bold text-neutral-800">Pending contributions</h2>
      {error && <p className="mt-4 text-sm text-alert-600">{error}</p>}
      {loading ? (
        <p className="mt-4 text-neutral-400">Loading…</p>
      ) : items.length === 0 && !error ? (
        <p className="mt-4 text-neutral-400">Nothing pending. 🎉</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((item) => (
            <li key={item.SK} className="rounded-cozy border border-paw-200 bg-white p-4">
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
              <p className="font-semibold text-neutral-800">{item.payload?.name ?? '(no name)'}</p>
              <p className="text-sm text-neutral-500 capitalize">
                {item.payload?.thingTypeId ?? 'unknown type'}
              </p>
              <button
                onClick={() => approve(item)}
                className="mt-2 rounded-full bg-leaf-400 px-4 py-1.5 text-sm font-semibold text-white hover:bg-leaf-600"
              >
                Approve
              </button>
            </li>
          ))}
        </ul>
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
            <li key={user.id} className="rounded-cozy border border-paw-200 bg-white p-4">
              <p className="font-semibold text-neutral-800">{user.displayName}</p>
              <p className="text-sm text-neutral-500">{user.professional?.domain}</p>
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
