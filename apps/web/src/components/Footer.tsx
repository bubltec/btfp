import { AppFooter } from '@bubltec/uiux';

export function Footer() {
  return (
    <AppFooter>
      <div className="w-full text-sm text-neutral-600">
        <p className="font-semibold text-alert-600">
          Not a substitute for veterinary care. If you suspect a poisoning, contact a vet
          immediately.
        </p>
        <p className="mt-1">
          ASPCA Animal Poison Control:{' '}
          <a className="underline" href="tel:+18884264435">
            +1-888-426-4435
          </a>{' '}
          &middot; Pet Poison Helpline:{' '}
          <a className="underline" href="tel:+18557647661">
            +1-855-764-7661
          </a>
        </p>
        <p className="mt-4 text-neutral-400">
          Plant data adapted from the ASPCA Toxic and Non-Toxic Plants list. Community contributions
          are reviewed before publishing.
        </p>
        <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1">
          <a className="underline" href="/llm-info">
            LLM Information
          </a>
          <a className="underline" href="/privacy">
            Privacy Policy
          </a>
          <a className="underline" href="/terms">
            Terms of Service
          </a>
        </p>
      </div>
    </AppFooter>
  );
}
