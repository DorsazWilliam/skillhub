import { useEffect, useState, type ReactElement } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { Ic, MsLogo } from './lib/icons';
import { Av } from './ui/common';
import { brandName } from './lib/brand';

/**
 * Sign-in screen: the methods this hub enables (Microsoft, Google, your identity server, email link, passkey),
 * an invitation view for /login?invite=..., and the dev-only buttons on a local instance.
 */

interface DevUser {
  key: string;
  name: string;
  email: string;
  role: string;
}
interface Providers {
  providers: { key: 'microsoft' | 'google' | 'oidc'; label: string }[];
  email: boolean;
  passkeys: boolean;
  invites: boolean;
}
interface Invite {
  valid: boolean;
  email?: string;
  inviter?: string;
  accept_by_link?: boolean;
}

const ERRORS: Record<string, string> = {
  not_allowed: 'This account is not allowed here. Ask for an invitation.',
  expired: 'The sign-in took too long or the link was already used. Try again.',
  cancelled: 'Sign-in was cancelled',
  invalid: 'Sign-in failed, try again',
  suspended: 'This account is suspended',
  invite_used: 'This invitation was already used, cancelled or has expired',
  invite_mismatch: 'Sign in with the email address the invitation was sent to',
};

function GoogleLogo(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
      <path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.2-13.5-10l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}

export function Login({ error }: { error: string | null }): ReactElement {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get('invite');
  const ret = params.get('return_to') ?? (window.location.pathname === '/login' ? '/' : window.location.pathname + window.location.search);
  const safeRet = ret.startsWith('/') && !ret.startsWith('//') ? ret : '/';
  const [dev, setDev] = useState<DevUser[] | null>(null);
  const [prov, setProv] = useState<Providers | null>(null);
  const [inv, setInv] = useState<Invite | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    // Dev sign-in exists only on a localhost instance with DEV_LOGIN=true; elsewhere this is a 404.
    fetch('/auth/dev-login', { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<{ enabled: boolean; users: DevUser[] }>) : null))
      .then((d) => setDev(d?.enabled ? d.users : null))
      .catch(() => setDev(null));
    fetch('/auth/providers', { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<Providers>) : null))
      .then((p) => setProv(p ?? { providers: [{ key: 'microsoft', label: 'Microsoft' }], email: false, passkeys: false, invites: false }))
      .catch(() => setProv({ providers: [{ key: 'microsoft', label: 'Microsoft' }], email: false, passkeys: false, invites: false }));
    if (invite)
      fetch('/auth/invite/' + encodeURIComponent(invite), { credentials: 'same-origin' })
        .then((r) => r.json() as Promise<Invite>)
        .then(setInv)
        .catch(() => setInv({ valid: false }));
  }, [invite]);

  const org = dev?.[0]?.email.split('@')[1]?.split('.')[0] ?? '';
  const go = (provider: string): void => {
    const q = new URLSearchParams({ provider, return_to: safeRet });
    if (invite) q.set('invite', invite);
    window.location.href = '/auth/login?' + q.toString();
  };
  const devSignIn = async (key: string): Promise<void> => {
    setBusy(key);
    const r = await fetch('/auth/dev-login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-skillhub-csrf': '1' },
      body: JSON.stringify({ as: key }),
    });
    if (r.ok) window.location.href = safeRet;
    else setBusy(null);
  };
  const sendLink = async (): Promise<void> => {
    setBusy('email');
    setMsg(null);
    const r = await fetch('/auth/email', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-skillhub-csrf': '1' },
      body: JSON.stringify({ email, return_to: safeRet }),
    });
    setBusy(null);
    if (r.ok) setSent(true);
    else setMsg('Enter a valid email address');
  };
  const passkey = async (): Promise<void> => {
    setBusy('passkey');
    setMsg(null);
    try {
      const h = { 'content-type': 'application/json', 'x-skillhub-csrf': '1' };
      const o = await fetch('/auth/passkey/options', { method: 'POST', credentials: 'same-origin', headers: h });
      const response = await startAuthentication({ optionsJSON: await o.json() });
      const v = await fetch('/auth/passkey/verify', { method: 'POST', credentials: 'same-origin', headers: h, body: JSON.stringify({ response, return_to: safeRet }) });
      const j = (await v.json()) as { return_to?: string; error?: { message: string } };
      if (v.ok) window.location.href = j.return_to ?? '/';
      else setMsg(j.error?.message ?? 'That passkey did not work');
    } catch {
      setMsg('No passkey was used');
    }
    setBusy(null);
  };

  const err = error ? (ERRORS[error] ?? 'Sign-in failed') : null;
  return (
    <div className="screen">
      <div className="login">
        <span className="logo">
          <Ic n="layers" s={26} />
        </span>
        <div>
          <h1>{brandName()}</h1>
          <div className="sub">{org ? org[0]!.toUpperCase() + org.slice(1) : ' '}</div>
        </div>
        {invite && inv ? (
          inv.valid ? (
            <div className="invite-card">
              <b>{inv.inviter} invited you</b>
              <span className="muted">Sign in as {inv.email} to accept.</span>
              {inv.accept_by_link ? (
                <form method="post" action={`/auth/invite/${encodeURIComponent(invite)}/accept`}>
                  <button className="btn primary" type="submit" style={{ width: '100%', justifyContent: 'center', height: 40 }}>
                    <Ic n="check" s={15} />
                    <span>Continue as {inv.email}</span>
                  </button>
                </form>
              ) : null}
            </div>
          ) : (
            <div className="note" role="alert">
              <Ic n="alert" s={14} />
              <span>{ERRORS['invite_used']}</span>
            </div>
          )
        ) : null}
        {prov
          ? prov.providers.map((p) => (
              <button key={p.key} className="ms" data-provider={p.key} onClick={() => go(p.key)}>
                {p.key === 'microsoft' ? <MsLogo /> : p.key === 'google' ? <GoogleLogo /> : <Ic n="key" s={17} />}
                <span>Sign in with {p.label}</span>
              </button>
            ))
          : null}
        {prov?.passkeys ? (
          <button className="ms" data-provider="passkey" disabled={!!busy} onClick={() => void passkey()}>
            {busy === 'passkey' ? <Ic n="loader" s={17} c="spin" /> : <Ic n="key" s={17} />}
            <span>Sign in with a passkey</span>
          </button>
        ) : null}
        {prov?.email ? (
          sent ? (
            <div className="note ok-note" role="status">
              <Ic n="check" s={14} />
              <span>Check your inbox for a sign-in link.</span>
            </div>
          ) : (
            <form
              className="email-login"
              onSubmit={(e) => {
                e.preventDefault();
                void sendLink();
              }}
            >
              <input className="input" type="email" required placeholder="you@company.com" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="btn" type="submit" disabled={!!busy}>
                {busy === 'email' ? <Ic n="loader" s={14} c="spin" /> : null}
                <span>Email me a link</span>
              </button>
            </form>
          )
        ) : null}
        {err || msg ? (
          <div className="note" role="alert">
            <Ic n="alert" s={14} />
            <span>{msg ?? err}</span>
          </div>
        ) : null}
        {dev ? (
          <div className="dev-login" aria-label="Local sign-in">
            <div className="mlbl">Local development</div>
            {dev.map((u) => (
              <button key={u.key} className="mi" data-dev={u.key} disabled={!!busy} onClick={() => void devSignIn(u.key)}>
                <Av name={u.name} s={22} />
                <span>{u.key[0]!.toUpperCase() + u.key.slice(1)}</span>
                <span className="r">{busy === u.key ? <Ic n="loader" s={13} c="spin" /> : u.name.split(' ')[0]}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
