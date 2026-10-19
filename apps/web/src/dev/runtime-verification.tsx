import { useEffect, useState, type FormEvent } from 'react';
import { ensureCustomerSession, signInStaff } from '../lib/auth';
import { getCustomerSupabase } from '../lib/supabase';
import { getDatabaseHealth, getHealth, verifySession } from '../lib/api-client';

// Loaded only through a development-only route. Never displays identities or tokens.
export function RuntimeVerification() {
  const [api, setApi] = useState('Checking');
  const [database, setDatabase] = useState('Checking');
  const [anonymous, setAnonymous] = useState('Checking');
  const [persistence, setPersistence] = useState('Checking');
  const [serverAuth, setServerAuth] = useState('Checking');
  const [staff, setStaff] = useState('Not tested');
  const staffMode = new URLSearchParams(window.location.search).get('staff') === '1';
  useEffect(() => {
    let active = true;
    void getHealth().then(() => { if (active) setApi('Passed'); }).catch(() => { if (active) setApi('Failed'); });
    void getDatabaseHealth().then(ok => { if (active) setDatabase(ok ? 'Passed' : 'Failed'); }).catch(() => { if (active) setDatabase('Failed'); });
    if (staffMode) return () => { active = false; };
    void (async () => {
      try {
        const existing = await getCustomerSupabase().auth.getSession();
        const previousId = existing.data.session?.user.id;
        const session = await ensureCustomerSession();
        const verified = await getCustomerSupabase().auth.getUser(session.access_token);
        if (verified.error || !verified.data.user) throw new Error('Verification failed');
        const accepted = await verifySession(session.access_token);
        if (active) {
          setAnonymous(verified.data.user.is_anonymous ? 'Passed' : 'Existing staff session');
          setPersistence(previousId === session.user.id ? 'Restored' : 'Created');
          setServerAuth(accepted ? 'Passed' : 'Failed');
        }
      } catch (error) {
        if (active) {
          const disabled = typeof error === 'object' && error !== null && 'code' in error && error.code === 'anonymous_provider_disabled';
          setAnonymous(disabled ? 'Disabled in dashboard' : 'Failed');
          setPersistence('Not verified');
          setServerAuth('Not verified');
        }
      }
    })();
    return () => { active = false; };
  }, [staffMode]);

  async function testStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setStaff('Checking');
    try {
      const session = await signInStaff({ email: String(data.get('email')), password: String(data.get('password')) });
      const accepted = await verifySession(session.access_token, true);
      setStaff(accepted && !session.user.is_anonymous ? 'Passed' : 'Failed');
    } catch { setStaff('Failed'); }
    finally { form.reset(); }
  }

  return <main className="mx-auto max-w-2xl p-8">
    <h1 className="text-2xl font-semibold">Runtime verification</h1>
    <p className="mt-2 text-slate-600">Development checks only. No credentials or tokens are displayed.</p>
    <dl className="my-6 space-y-2">
      <div><dt className="inline font-medium">React → Express: </dt><dd className="inline" data-testid="api">{api}</dd></div>
      <div><dt className="inline font-medium">Express → PostgreSQL: </dt><dd className="inline" data-testid="database">{database}</dd></div>
      {!staffMode && <>
        <div><dt className="inline font-medium">Anonymous Auth: </dt><dd className="inline" data-testid="anonymous">{anonymous}</dd></div>
        <div><dt className="inline font-medium">Session: </dt><dd className="inline" data-testid="persistence">{persistence}</dd></div>
        <div><dt className="inline font-medium">Express token verification: </dt><dd className="inline" data-testid="server-auth">{serverAuth}</dd></div>
      </>}
    </dl>
    {staffMode && <form onSubmit={event => { void testStaff(event); }} className="space-y-4">
      <label className="block">Test staff email<input className="block w-full rounded border p-2" name="email" type="email" required autoComplete="off" /></label>
      <label className="block">Test staff password<input className="block w-full rounded border p-2" name="password" type="password" required autoComplete="off" /></label>
      <button className="rounded bg-teal-800 px-4 py-2 text-white" type="submit">Verify staff authentication</button>
      <p data-testid="staff">{staff}</p>
    </form>}
  </main>;
}
