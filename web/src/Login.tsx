import { useEffect, useState, type ReactElement } from 'react';
import { uiOnly } from './api/client';
import { Ic, MsLogo } from './lib/icons';
import { Av } from './ui/common';
import { brandName } from './lib/brand';

/** Sign-in screen (prototype loginHtml). The dev-only buttons appear only when the Worker reports dev sign-in is on. */

interface DevUser {
  key: string;
  name: string;
  email: string;
  role: string;
}

const ERRORS: Record<string, string> = {
  not_allowed: 'This account is not allowed here',
  expired: 'The sign-in took too long, try again',
  cancelled: 'Sign-in was cancelled',
  invalid: 'Sign-in failed, try again',
};

export function Login({ error }: { error: string | null }): ReactElement {
  const [dev, setDev] = useState<DevUser[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ret = new URLSearchParams(window.location.search).get('return_to') ?? (window.location.pathname === '/login' ? '/' : window.location.pathname + window.location.search);
  useEffect(() => {
    // Dev sign-in exists only on a localhost instance with DEV_LOGIN=true; elsewhere this is a 404.
    fetch('/auth/dev-login', { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<{ enabled: boolean; users: DevUser[] }>) : null))
      .then((d) => setDev(d?.enabled ? d.users : null))
      .catch(() => setDev(null));
  }, []);
  const org = dev?.[0]?.email.split('@')[1]?.split('.')[0] ?? '';
  const devSignIn = async (key: string): Promise<void> => {
    setBusy(key);
    const r = await fetch('/auth/dev-login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-skillhub-csrf': '1' },
      body: JSON.stringify({ as: key }),
    });
    if (r.ok) window.location.href = ret.startsWith('/') && !ret.startsWith('//') ? ret : '/';
    else setBusy(null);
  };
  return (
    <div className="screen">
      <div className="login">
        <span className="logo">
          <Ic n="layers" s={26} />
        </span>
        <div>
          <h1>{brandName()}</h1>
          <div className="sub">{org ? org[0]!.toUpperCase() + org.slice(1) : ' '}</div>
        </div>
        <button className="ms" onClick={() => uiOnly.login(ret)}>
          <MsLogo />
          <span>Sign in with Microsoft</span>
        </button>
        {error ? (
          <div className="note" role="alert">
            <Ic n="alert" s={14} />
            <span>{ERRORS[error] ?? 'Sign-in failed'}</span>
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
