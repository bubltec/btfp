import { useEffect, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import type { QuizQuestion } from '@btfp/shared-types';
import { api } from '../lib/api.js';

export function QuizDialog({ onPassed }: { onPassed: () => void }) {
  const [open, setOpen] = useState(false);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [answers, setAnswers] = useState<number[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    api.getQuiz().then((qs) => {
      setQuestions(qs);
      setAnswers(Array.from({ length: qs.length }, () => -1));
    });
  }, [open]);

  async function submit() {
    setSubmitting(true);
    try {
      await api.submitQuiz(questions, answers);
      onPassed();
      setOpen(false);
    } catch (err) {
      setResult(err instanceof Error ? err.message : 'Quiz not passed — try again!');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="rounded-full bg-paw-500 px-5 py-2 font-semibold text-white hover:bg-paw-600">
        Prove you know your kibble 🐾
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-cozy bg-white p-6 shadow-xl">
          <Dialog.Title className="text-lg font-bold text-neutral-800">
            Pet safety pop quiz
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-neutral-500">
            Three questions, drawn straight from our database. Get them all right to unlock adding
            entries.
          </Dialog.Description>

          <div className="mt-4 space-y-4">
            {questions.map((question, qi) => (
              <fieldset key={question.id}>
                <legend className="font-semibold text-neutral-700">{question.prompt}</legend>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {question.choices.map((choice, ci) => (
                    <label
                      key={choice}
                      className={`cursor-pointer rounded-lg border px-3 py-2 text-sm ${
                        answers[qi] === ci ? 'border-paw-500 bg-paw-50' : 'border-paw-200'
                      }`}
                    >
                      <input
                        type="radio"
                        name={question.id}
                        className="sr-only"
                        checked={answers[qi] === ci}
                        onChange={() =>
                          setAnswers((prev) => prev.map((a, i) => (i === qi ? ci : a)))
                        }
                      />
                      {choice}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>

          {result && <p className="mt-3 text-sm text-alert-600">{result}</p>}

          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close className="rounded-full px-4 py-2 text-sm text-neutral-500">
              Cancel
            </Dialog.Close>
            <button
              onClick={submit}
              disabled={submitting || answers.includes(-1)}
              className="rounded-full bg-paw-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {submitting ? 'Checking…' : 'Submit answers'}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
