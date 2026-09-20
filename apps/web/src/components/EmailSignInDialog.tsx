import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { api } from '../lib/api.js';

type Step = 'email' | 'code';

/**
 * A full sign-in path, independent of GitHub/Google — for vets and
 * scientists who'd rather prove they work somewhere than create a GitHub
 * account. Confirming the code both creates the identity and starts the
 * professional-verification review, all in one flow.
 */
const DEFAULT_TRIGGER_CLASS =
  'rounded-full border-2 border-paw-500 px-3 py-1 text-sm font-semibold text-paw-600 hover:bg-paw-50';

export function EmailSignInDialog({
  onSignedIn,
  triggerClassName = DEFAULT_TRIGGER_CLASS,
}: {
  onSignedIn: () => void;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setStep('email');
    setEmail('');
    setCode('');
    setError(null);
  }

  async function submitEmail() {
    setSubmitting(true);
    setError(null);
    try {
      await api.requestEmailSignIn(email);
      setStep('code');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCode() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.confirmEmailSignIn(email, code);
      if (!result.confirmed)
        throw new Error('That code is wrong or expired — check your email and try again.');
      onSignedIn();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Dialog.Trigger className={triggerClassName}>
        <span className="hidden sm:inline">Sign in with work email</span>
        <span className="sm:hidden">Email</span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-cozy bg-white p-6 shadow-xl">
          <Dialog.Title className="text-lg font-bold text-neutral-800">
            Sign in with your work email
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-neutral-500">
            No GitHub account needed — use your organizational email instead. Once reviewed, you'll
            be able to contribute directly.
          </Dialog.Description>

          {step === 'email' && (
            <div className="mt-4 space-y-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourclinic.org"
                className="w-full rounded-lg border border-paw-200 px-3 py-2"
              />
              {error && <p className="text-sm text-alert-600">{error}</p>}
              <div className="flex justify-end gap-2">
                <Dialog.Close className="rounded-full px-4 py-2 text-sm text-neutral-500">
                  Cancel
                </Dialog.Close>
                <button
                  onClick={submitEmail}
                  disabled={submitting || !email}
                  className="rounded-full bg-paw-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {submitting ? 'Sending…' : 'Send code'}
                </button>
              </div>
            </div>
          )}

          {step === 'code' && (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-neutral-600">
                We sent a 6-digit code to <strong>{email}</strong>
              </p>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                className="w-full rounded-lg border border-paw-200 px-3 py-2 tracking-widest"
              />
              {error && <p className="text-sm text-alert-600">{error}</p>}
              <div className="flex justify-end gap-2">
                <Dialog.Close className="rounded-full px-4 py-2 text-sm text-neutral-500">
                  Cancel
                </Dialog.Close>
                <button
                  onClick={submitCode}
                  disabled={submitting || code.length !== 6}
                  className="rounded-full bg-paw-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {submitting ? 'Signing in…' : 'Sign in'}
                </button>
              </div>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
