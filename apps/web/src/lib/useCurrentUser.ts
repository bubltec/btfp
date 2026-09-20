import { useCallback, useEffect, useState } from 'react';
import { api, type CurrentUser } from './api.js';

export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined);

  const refresh = useCallback(
    () =>
      api
        .me()
        .then(setUser)
        .catch(() => setUser(null)),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    user,
    loading: user === undefined,
    refresh,
  };
}
