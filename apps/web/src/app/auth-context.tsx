import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { getSupabase } from '../lib/supabase';
interface AuthState { session: Session | null; loading: boolean; error: string | null; }
const AuthContext = createContext<AuthState>({ session: null, loading: true, error: null });
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, loading: true, error: null });
  useEffect(() => {
    let active = true;
    try {
      const client = getSupabase();
      const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
        if (active) setState({ session, loading: false, error: null });
      });
      void client.auth.getSession().then(({ data, error }) => {
        if (active) setState({ session: data.session, loading: false, error: error ? 'Unable to restore your session. Please sign in again.' : null });
      }).catch(() => { if (active) setState({ session: null, loading: false, error: 'Authentication is unavailable.' }); });
      return () => { active = false; listener.subscription.unsubscribe(); };
    } catch {
      setState({ session: null, loading: false, error: 'Supabase authentication is not configured.' });
      return () => { active = false; };
    }
  }, []);
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
export function RequireStaffSession() {
  const { session, loading, error } = useAuth();
  const location = useLocation();
  if (loading) return <p className="p-8" role="status">Checking your session…</p>;
  if (error) return <p className="p-8 text-red-700" role="alert">{error}</p>;
  if (!session || session.user.is_anonymous) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <Outlet key={session.user.id} />;
}
