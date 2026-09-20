import { Link } from 'react-router-dom';
import { isNonProdHost } from '../lib/env.js';
import { useCurrentUser } from '../lib/useCurrentUser.js';
import { EmailSignInDialog } from './EmailSignInDialog.js';

export function Nav() {
  const { user, refresh } = useCurrentUser();

  return (
    <header className="sticky top-0 z-10 border-b border-paw-200 bg-paw-50/90 backdrop-blur">
      <nav className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
        <Link
          to="/"
          className="flex shrink-0 items-center gap-2 text-base font-extrabold text-paw-600 sm:text-lg"
        >
          <span aria-hidden>🐾</span>
          badthingsforpets
        </Link>
        <div className="mt-2 flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-paw-100 pt-2 text-sm font-semibold text-paw-600 sm:mt-0 sm:w-auto sm:border-0 sm:pt-0">
          <div className="flex items-center gap-x-4">
            <Link to="/submit" className="inline-block py-1.5 hover:underline">
              <span className="hidden sm:inline">Add a thing</span>
              <span className="sm:hidden">Add</span>
            </Link>
            {user && (user.verifiedContributor || isNonProdHost()) && (
              <Link to="/moderation" className="inline-block py-1.5 hover:underline">
                Moderation
              </Link>
            )}
          </div>
          {user ? (
            <div className="flex items-center gap-2">
              <span className="max-w-[8rem] truncate rounded-full bg-paw-100 px-3 py-1 text-paw-600 sm:max-w-none">
                Hi, {user.displayName}
              </span>
              <a href="/api/auth/logout" className="inline-block py-1.5 hover:underline">
                Sign out
              </a>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <EmailSignInDialog onSignedIn={refresh} />
              <a
                href="/api/auth/github"
                className="rounded-full bg-paw-500 px-3 py-1 text-white hover:bg-paw-600"
              >
                <span className="hidden sm:inline">Sign in with GitHub</span>
                <span className="sm:hidden">GitHub</span>
              </a>
            </div>
          )}
        </div>
      </nav>
    </header>
  );
}
