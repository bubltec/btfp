import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Severity } from '@btfp/shared-types';
import { useCurrentUser } from '../lib/useCurrentUser.js';
import { api } from '../lib/api.js';
import { QuizDialog } from '../components/QuizDialog.js';
import { ProfessionalVerificationDialog } from '../components/ProfessionalVerificationDialog.js';
import { EmailSignInDialog } from '../components/EmailSignInDialog.js';

const THING_TYPES = ['plant', 'food', 'medication', 'product', 'activity', 'object'];
const PET_TYPES = ['dog', 'cat', 'horse'];
const SEVERITIES: Severity[] = ['unknown', 'mild', 'moderate', 'severe'];

export function SubmitPage() {
  const { user, loading, refresh } = useCurrentUser();
  const navigate = useNavigate();
  const { id: editingId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();

  const [name, setName] = useState(searchParams.get('name') ?? '');
  const [thingTypeId, setThingTypeId] = useState('plant');
  const [petSeverities, setPetSeverities] = useState<Record<string, Severity>>({ dog: 'unknown' });
  const [notes, setNotes] = useState('');
  const [source, setSource] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loadingThing, setLoadingThing] = useState(Boolean(editingId));

  useEffect(() => {
    if (!editingId) return;
    setLoadingThing(true);
    api
      .getThing(editingId)
      .then((thing) => {
        setName(thing.name);
        setThingTypeId(thing.thingTypeId);
        setPetSeverities(Object.fromEntries(thing.petTypes.map((p) => [p.petTypeId, p.severity])));
        setNotes(typeof thing.details.notes === 'string' ? thing.details.notes : '');
        setSource(thing.source);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoadingThing(false));
  }, [editingId]);

  if (loading || loadingThing)
    return <div className="mx-auto max-w-xl px-4 py-10 text-neutral-400">Loading…</div>;

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Sign in to contribute</h1>
        <p className="mt-2 text-neutral-500">
          GitHub proves a real person with some history is behind each entry. If you're a vet or
          scientist without a GitHub account, sign in with your work email instead.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <a
            href="/api/auth/github"
            className="inline-block rounded-full bg-paw-500 px-6 py-3 font-semibold text-white hover:bg-paw-600"
          >
            Sign in with GitHub
          </a>
          <EmailSignInDialog
            onSignedIn={refresh}
            triggerClassName="inline-block rounded-full border-2 border-paw-500 px-6 py-3 font-semibold text-paw-600 hover:bg-paw-50"
          />
        </div>
      </div>
    );
  }

  if (!user.verifiedContributor) {
    // A pending professional review doesn't block someone who's already
    // gotten in some other way (e.g. the quiz) — only shown when that's
    // the reason they're not verified yet.
    if (user.professional?.status === 'awaiting_review') {
      return (
        <div className="mx-auto max-w-xl px-4 py-16 text-center">
          <h1 className="text-2xl font-bold text-neutral-800">Almost there</h1>
          <p className="mt-2 text-neutral-500">
            Your organization ({user.professional.domain}) is confirmed and waiting on a quick human
            review. You can also just take the quiz now instead of waiting.
          </p>
          <div className="mt-6 flex justify-center">
            <QuizDialog onPassed={refresh} />
          </div>
        </div>
      );
    }

    const wasRejected = user.professional?.status === 'rejected';
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">One quick step first</h1>
        <p className="mt-2 text-neutral-500">
          Clear our pet-safety pop quiz, or verify a work email if you're a vet or scientist —
          either unlocks adding and editing entries.
        </p>
        {wasRejected && (
          <p className="mt-2 text-sm text-alert-600">
            Your last organization verification wasn't approved
            {user.professional?.rejectionReason && ` (${user.professional.rejectionReason})`}.
            You're welcome to try again with a different address.
          </p>
        )}
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <QuizDialog onPassed={refresh} />
          <ProfessionalVerificationDialog onSubmitted={refresh} />
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Thanks! 🐾</h1>
        <p className="mt-2 text-neutral-500">
          {editingId
            ? 'Your edit is in the moderation queue for review.'
            : 'Your submission is in the moderation queue for review.'}
        </p>
        <button
          onClick={() => navigate(editingId ? `/things/${editingId}` : '/')}
          className="mt-6 rounded-full bg-paw-500 px-6 py-3 font-semibold text-white"
        >
          {editingId ? 'Back to entry' : 'Back home'}
        </button>
      </div>
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.submitContribution(
        {
          name,
          thingTypeId,
          petTypes: Object.entries(petSeverities).map(([petTypeId, severity]) => ({
            petTypeId,
            severity,
          })),
          details: { notes },
          source: source || `contributor:${user?.displayName}`,
        },
        editingId,
      );
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  function togglePetType(id: string) {
    setPetSeverities((prev) => {
      if (id in prev) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: 'unknown' };
    });
  }

  function setSeverityFor(id: string, severity: Severity) {
    setPetSeverities((prev) => ({ ...prev, [id]: severity }));
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-2xl font-bold text-neutral-800">
        {editingId ? `Edit ${name || 'this entry'}` : 'Add a dangerous thing'}
      </h1>
      <form onSubmit={handleSubmit} className="mt-6 space-y-5">
        <div>
          <label htmlFor="thing-name" className="block text-sm font-semibold text-neutral-700">
            Name
          </label>
          <input
            id="thing-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-paw-200 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="thing-type" className="block text-sm font-semibold text-neutral-700">
            Type
          </label>
          <select
            id="thing-type"
            value={thingTypeId}
            onChange={(e) => setThingTypeId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-paw-200 px-3 py-2 capitalize"
          >
            {THING_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-semibold text-neutral-700">Dangerous for</label>
          <p className="mt-1 text-xs text-neutral-400">
            Pick a severity per pet — this drives the vet-urgency guidance shown on the entry page.
          </p>
          <div className="mt-2 space-y-2">
            {PET_TYPES.map((pt) => (
              <div key={pt} className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1 text-sm capitalize">
                  <input
                    type="checkbox"
                    checked={pt in petSeverities}
                    onChange={() => togglePetType(pt)}
                  />
                  {pt}
                </label>
                {pt in petSeverities && (
                  <select
                    value={petSeverities[pt]}
                    onChange={(e) => setSeverityFor(pt, e.target.value as Severity)}
                    className="rounded-lg border border-paw-200 px-2 py-1 text-sm capitalize"
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="thing-notes" className="block text-sm font-semibold text-neutral-700">
            Why is it dangerous?
          </label>
          <textarea
            id="thing-notes"
            required
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            className="mt-1 w-full rounded-lg border border-paw-200 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="thing-source" className="block text-sm font-semibold text-neutral-700">
            Source (optional)
          </label>
          <input
            id="thing-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Vet, article, personal experience…"
            className="mt-1 w-full rounded-lg border border-paw-200 px-3 py-2"
          />
        </div>

        {error && <p className="text-sm text-alert-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting || Object.keys(petSeverities).length === 0}
          className="w-full rounded-full bg-paw-500 px-6 py-3 font-semibold text-white disabled:opacity-50"
        >
          {submitting
            ? editingId
              ? 'Submitting edit…'
              : 'Submitting…'
            : editingId
              ? 'Submit edit for review'
              : 'Submit for review'}
        </button>
      </form>
    </div>
  );
}
