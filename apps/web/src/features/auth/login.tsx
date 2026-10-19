import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { staffCredentialsSchema } from '@qevra/contracts';
import { useAuth } from '../../app/auth-context';
import { signInStaff } from '../../lib/auth';
import { Button, Field, ErrorNotice, Panel, Loading } from '../../components/ui';
export function LoginPage() {
  const auth = useAuth(), navigate = useNavigate(), location = useLocation();
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  if (auth.loading) return <Loading />;
  if (auth.session && !auth.session.user.is_anonymous) return <Navigate to="/app" replace />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const parsed = staffCredentialsSchema.safeParse({ email: form.get('email'), password: form.get('password') });
    if (!parsed.success) { setError('Enter a valid email and password.'); return; }
    setBusy(true); setError(null);
    try {
      await signInStaff(parsed.data);
      const from: unknown = location.state?.from;
      navigate(typeof from === 'string' && from.startsWith('/app/') ? from : '/app', { replace: true });
    } catch { setError('Unable to sign in. Check your email and password, and confirm your account is active.'); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto max-w-md"><Panel title="Welcome back"><p className="mb-6 text-sm text-slate-500">Sign in to configure your business, branches and team.</p>
    <form onSubmit={event => { void submit(event); }} className="space-y-4">
      <Field label="Email"><input className="input" name="email" type="email" required autoComplete="username" /></Field>
      <Field label="Password"><input className="input" name="password" type="password" required autoComplete="current-password" /></Field>
      <ErrorNotice message={error || auth.error} /><Button disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</Button>
    </form><p className="mt-5 text-xs text-slate-500">New to Qevra? <Link to="/register" className="text-teal-800 underline">Create an account</Link>. Team members register first, then an owner adds their email.</p></Panel><Link className="mt-5 inline-block text-sm text-teal-800" to="/">← Back to Qevra</Link></div>;
}
