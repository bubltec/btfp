import { Link } from 'react-router-dom';
import { AppHeader } from '@bubltec/uiux';
import { isNonProdHost } from '../lib/env.js';
import { useCurrentUser } from '../lib/useCurrentUser.js';
import { EmailSignInDialog } from './EmailSignInDialog.js';

export function Nav() {
  const { user, refresh } = useCurrentUser();

  return (
    <AppHeader
      sticky
      brand={
        <Link
          to="/"
          className="flex items-center gap-2 text-base font-extrabold text-paw-600 no-underline"
        >
          <span aria-hidden>🐾</span>
          badthingsforpets
        </Link>
      }
      nav={
        <>
          <Link to="/submit">
            <span className="hidden sm:inline">Add a thing</span>
            <span className="sm:hidden">Add</span>
          </Link>
          {user && (user.verifiedContributor || isNonProdHost()) && (
            <Link to="/moderation">Moderation</Link>
          )}
        </>
      }
      trailing={
        user ? (
          <div className="flex items-center gap-2 text-sm font-semibold text-paw-600">
            <span className="max-w-[8rem] truncate rounded-full bg-paw-100 px-3 py-1 sm:max-w-none">
              Hi, {user.displayName}
            </span>
            <a href="/api/auth/logout" className="py-1.5">
              Sign out
            </a>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <EmailSignInDialog onSignedIn={refresh} />
            <a href="/api/auth/github" className="btn">
              <span className="hidden sm:inline">Sign in with GitHub</span>
              <span className="sm:hidden">GitHub</span>
            </a>
          </div>
        )
      }
    />
  );
}
