import brand from '../../brand.json';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { devLoginEnabled } from './dev';

/**
 * Outgoing email: sign-in links and invitations.
 * Transports: smtp (Node, SMTP_URL), resend (RESEND_API_KEY, anywhere), log (prints the message), memory (tests).
 * Without one, email sign-in is off and invitation links are shown to the inviter to send themselves.
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Messages sent with EMAIL_TRANSPORT=memory (tests read them). */
export const outbox: Mail[] = [];

function transport(env: Env): string | null {
  const t = env.EMAIL_TRANSPORT?.toLowerCase();
  if (t) return t;
  if (env.SEND_MAIL) return 'smtp';
  if (env.RESEND_API_KEY) return 'resend';
  if (devLoginEnabled(env)) return 'log';
  return null;
}

export function emailConfigured(env: Env): boolean {
  return transport(env) !== null;
}

export async function sendMail(env: Env, m: Mail): Promise<void> {
  const from = env.EMAIL_FROM || `${brand.name} <no-reply@${new URL(env.BASE_URL).hostname}>`;
  const t = transport(env);
  if (t === 'memory') {
    outbox.push(m);
    // Also in KV, so tests running the app in another isolate can read it.
    await env.OAUTH_KV.put(`mail:${Date.now()}:${crypto.randomUUID()}`, JSON.stringify(m), { expirationTtl: 600 });
    return;
  }
  if (t === 'log') {
    console.log(JSON.stringify({ level: 'info', msg: 'email (not sent: EMAIL_TRANSPORT=log)', to: m.to, subject: m.subject, text: m.text }));
    return;
  }
  if (t === 'smtp') {
    if (!env.SEND_MAIL) throw new AppError('internal', 'SMTP is only available on the Node runtime (SMTP_URL)');
    await env.SEND_MAIL({ from, ...m });
    return;
  }
  if (t === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    });
    if (!r.ok) throw new AppError('internal', `Email could not be sent (${r.status})`);
    return;
  }
  throw new AppError('internal', 'Email is not configured');
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, lines: string[], link: string, button: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a;max-width:520px;margin:32px auto;padding:0 16px">
<h2 style="font-size:20px;margin:0 0 12px">${esc(title)}</h2>
${lines.map((l) => `<p style="margin:0 0 12px;line-height:1.5">${esc(l)}</p>`).join('')}
<p style="margin:20px 0"><a href="${esc(link)}" style="background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">${esc(button)}</a></p>
<p style="color:#64748b;font-size:13px">Or open this link: ${esc(link)}</p>
</body></html>`;
}

export function signInMail(to: string, link: string): Mail {
  const lines = [`Use this link to sign in to ${brand.name}. It works once and expires in 15 minutes.`, 'If you did not ask for it, ignore this email.'];
  return { to, subject: `Sign in to ${brand.name}`, text: `${lines.join('\n\n')}\n\n${link}\n`, html: layout(`Sign in to ${brand.name}`, lines, link, 'Sign in') };
}

export function inviteMail(to: string, inviter: string, what: string, link: string): Mail {
  const lines = [`${inviter} invited you to ${brand.name}${what ? `: ${what}` : ''}.`, 'The invitation expires in 14 days.'];
  return {
    to,
    subject: `${inviter} invited you to ${brand.name}`,
    text: `${lines.join('\n\n')}\n\n${link}\n`,
    html: layout(`You are invited to ${brand.name}`, lines, link, 'Accept the invitation'),
  };
}
