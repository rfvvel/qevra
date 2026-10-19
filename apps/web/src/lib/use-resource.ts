import { useCallback, useEffect, useState } from 'react';
import { errorMessage, request } from './configuration-api';
export function useResource<T>(path: string, isPublic = false) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ path: string; data: T | null; error: string | null; loading: boolean }>({ path, data: null, error: null, loading: true });
  const reload = useCallback(() => setVersion(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ path, data: null, error: null, loading: true });
    void request<T>(path, { public: isPublic, signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ path, data, error: null, loading: false });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ path, data: null, error: errorMessage(error), loading: false });
    });
    return () => controller.abort();
  }, [path, isPublic, version]);
  return { ...(state.path === path ? state : { data: null, error: null, loading: true }), reload };
}
