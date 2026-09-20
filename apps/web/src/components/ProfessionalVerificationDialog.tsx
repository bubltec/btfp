import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { api } from '../lib/api.js';

type Step = 'email' | 'code' | 'submitted';

export function ProfessionalVerificationDialog({ onSubmitted }: { onSubmitted: () => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [orgClassification, setOrgClassification] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setStep('email');
    setEmail('');
    setCode('');
    setOrgClassification(undefined);
    setError(null);
  }

  async function submitEmail() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.requestProfessionalVerification(email);
      setOrgClassification(result.orgClassification);
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
      const result = await api.confirmProfessionalVerification(code);
      if (!result.confirmed)
        throw new Error('That code is wrong or expired — check your email and try again.');
      setStep('submitted');
      onSubmitted();
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
      <Dialog.Trigger className="rounded-full border-2 border-paw-500 px-5 py-2 font-semibold text-paw-600 hover:bg-paw-50">
        I'm a vet or scientist 🩺
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-cozy bg-white p-6 shadow-xl">
          <Dialog.Title className="text-lg font-bold text-neutral-800">
            Verify your organization
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-neutral-500">
            Use your work email — not a personal address — to skip the quiz and get a verified badge
            once reviewed.
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
                {orgClassification && orgClassification !== 'likely_personal_or_unclear' && (
                  <> — looks like a {orgClassification.replaceAll('_', ' ')}, nice.</>
                )}
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
                  {submitting ? 'Checking…' : 'Confirm'}
                </button>
              </div>
            </div>
          )}

          {step === 'submitted' && (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-neutral-600">
                Thanks — your organization is confirmed and waiting on a quick human review. You'll
                be able to contribute as soon as it's approved.
              </p>
              <div className="flex justify-end">
                <Dialog.Close className="rounded-full bg-paw-500 px-4 py-2 text-sm font-semibold text-white">
                  Done
                </Dialog.Close>
              </div>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
