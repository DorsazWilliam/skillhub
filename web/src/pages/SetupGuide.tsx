import { useState, useSyncExternalStore, type ReactElement } from 'react';
import { useMe } from '../api/hooks';
import { Ic } from '../lib/icons';
import { ago } from '../lib/util';
import { ClientAv, IB } from '../ui/common';
import { copyText } from '../ui/feedback';
import { useAreaCounts } from './Folder';
import { useConns, connName } from './Admin';

/**
 * First-run setup guide on Connections: copy the URL, follow the client's steps, try a prompt.
 * Shown until dismissed (per browser), and brought back with the Setup guide button.
 */

const KEY = 'skillhub.guide';
const subs = new Set<() => void>();
function readOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}
let on = readOn();

export function setGuide(v: boolean): void {
  on = v;
  try {
    if (v) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'off');
  } catch {
    // Storage blocked: the choice lasts for this page load.
  }
  for (const f of subs) f();
}

export function useGuideOn(): boolean {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => on,
  );
}

type ClientKey = 'Claude' | 'ChatGPT' | 'Copilot Studio';
const CLIENTS: Record<ClientKey, { sub: string; steps: ReactElement[]; match: RegExp; cli?: (url: string) => string }> = {
  Claude: {
    sub: 'claude.ai, Claude Desktop or Claude Code',
    match: /claude/i,
    steps: [
      <>
        Open <b>Settings → Connectors</b>
      </>,
      <>
        <b>Add custom connector</b>, name it SkillHub and paste the URL
      </>,
      <>
        <b>Connect</b>, sign in with Microsoft, keep <code>read</code> and <code>write</code> ticked
      </>,
    ],
    cli: (url) => `claude mcp add --transport http skillhub ${url}`,
  },
  ChatGPT: {
    sub: 'Your workspace admin may need to allow custom connectors first',
    match: /chatgpt|openai/i,
    steps: [
      <>
        Open <b>Settings → Apps &amp; Connectors → Advanced</b> and turn on developer mode if asked
      </>,
      <>
        <b>Create</b> a connector, paste the URL, authentication <b>OAuth</b>
      </>,
      <>
        <b>Connect</b>, sign in with Microsoft, keep <code>read</code> and <code>write</code> ticked
      </>,
    ],
  },
  'Copilot Studio': {
    sub: 'Set up once per agent by whoever builds it',
    match: /copilot/i,
    steps: [
      <>
        In your agent: <b>Tools → Add a tool → New tool → Model Context Protocol</b>
      </>,
      <>
        Paste the URL, authentication <b>OAuth 2.0</b>, type <b>Dynamic discovery</b>
      </>,
      <>Sign in with Microsoft and choose the scopes the agent needs</>,
    ],
  },
};
const TRY = 'What skills do we have for code review?';

function Copy({ text, label }: { text: string; label: string }): ReactElement {
  return (
    <div className="urlbox">
      <span>{text}</span>
      <IB className="ib sm" icon="copy" s={15} tip="Copy" aria-label={label} onClick={() => copyText(text)} />
    </div>
  );
}

export function SetupGuide({ mobile }: { mobile?: boolean }): ReactElement {
  const me = useMe();
  const conns = useConns();
  const counts = useAreaCounts();
  const [c, setC] = useState<ClientKey>('Claude');
  const url = me.data?.mcp_url ?? '';
  const g = CLIENTS[c];
  const connected = (k: ClientKey) => (conns.data?.items ?? []).filter((x) => CLIENTS[k].match.test(connName(x))).sort((a, b) => b.created_at - a.created_at)[0];
  const conn = connected(c);
  let n = 1;
  const step = (body: ReactElement, key: string): ReactElement => (
    <li key={key}>
      <span className="g-n">{n++}</span>
      <div className="g-b">{body}</div>
    </li>
  );
  return (
    <section className={'guide' + (mobile ? ' mob' : '')} aria-label="Setup guide">
      <div className="g-head">
        <div className="grow">
          <h2>Connect your agent</h2>
          <div className="muted">Do this once. After that, every chat starts with the team's rules, and the agent loads skills and docs when it needs them.</div>
        </div>
        <IB className="ib sm" icon="x" s={16} tip="Dismiss" aria-label="Dismiss setup guide" onClick={() => setGuide(false)} />
      </div>
      <div className="g-got">
        <span className="chip">
          <span className="ac-rules">
            <Ic n="scroll" s={13} />
          </span>
          {counts.rules ?? '…'} rules, always on
        </span>
        <span className="chip">
          <span className="ac-skills">
            <Ic n="sparkles" s={13} />
          </span>
          {counts.skills ?? '…'} skills
        </span>
        <span className="chip">
          <span className="ac-docs">
            <Ic n="book" s={13} />
          </span>
          {counts.docs ?? '…'} docs
        </span>
      </div>
      <div className="g-clients" role="tablist" aria-label="Client">
        {(Object.keys(CLIENTS) as ClientKey[]).map((k) => (
          <button key={k} role="tab" aria-selected={k === c} className={k === c ? 'on' : ''} onClick={() => setC(k)}>
            <ClientAv name={k} s={22} />
            <span>{k}</span>
            {connected(k) ? (
              <span className="g-ok" aria-label="Connected">
                <Ic n="check" s={12} />
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="muted g-sub">{g.sub}</div>
      <ol className="g-steps">
        {step(
          <>
            Copy the connector URL
            <Copy text={url} label="Copy URL" />
          </>,
          'url',
        )}
        {g.steps.map((s, i) => step(s, 's' + i))}
        {g.cli ? (
          <li className="g-alt">
            <span className="g-n">
              <Ic n="terminal" s={12} />
            </span>
            <div className="g-b">
              Claude Code instead: run this, then <code>/mcp</code> to sign in
              <Copy text={g.cli(url)} label="Copy command" />
            </div>
          </li>
        ) : null}
        {step(
          <>
            Try it in a new chat
            <div className="g-try">
              <span>“{TRY}”</span>
              <IB className="ib sm" icon="copy" s={15} tip="Copy" aria-label="Copy prompt" onClick={() => copyText(TRY)} />
            </div>
          </>,
          'try',
        )}
      </ol>
      <div className="g-foot">
        {conn ? (
          <span className="chip ok">
            <Ic n="check" s={12} />
            {c} connected {ago(conn.created_at) === 'now' ? 'just now' : ago(conn.created_at) + ' ago'}
          </span>
        ) : (
          <span className="muted row-flex" style={{ fontSize: 12.5, gap: 6 }}>
            <Ic n="clock" s={13} />
            Not connected yet
          </span>
        )}
        <div className="grow" />
        <button className="btn sm" onClick={() => setGuide(false)}>
          Done
        </button>
      </div>
    </section>
  );
}

/** Header button that brings the guide back once dismissed. */
export function GuideButton({ block }: { block?: boolean }): ReactElement | null {
  const shown = useGuideOn();
  if (shown) return null;
  return (
    <button className="btn" data-tip="Show the setup guide again" style={block ? { width: '100%', justifyContent: 'center' } : undefined} onClick={() => setGuide(true)}>
      <Ic n="info" s={15} />
      <span>Setup guide</span>
    </button>
  );
}
