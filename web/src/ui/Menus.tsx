import type { ReactElement, ReactNode } from 'react';
import { Ic } from '../lib/icons';
import { Av } from './common';
import { useUI, setUI, toggleTheme, isDark, openMany, type MenuState } from '../state';
import { useNode, useMe, useVersions, useWarnings, role, type NodeT } from '../api/hooks';
import { ago } from '../lib/util';
import { goNode, isMobile, logout, deleteNode, unpublish, dismissWarning, restoreWarnings, narrowMQ } from '../actions';
import { navigate } from '../router';
import { copyLink } from '../pages/Doc';
import { useInSkill, newKinds, runNew } from '../pages/Folder';
import { viewFor } from '../pages/docModel';
import { useTokens, useConns, useTrash, revokeToken, revokeConn, setUserStatus, connName } from '../pages/Admin';
import { restoreNode } from '../actions';
import { useUsers } from '../api/hooks';

/** Popover menus on desktop, action sheets on the phone (prototype menuHtml). */

function Mi({ icon, label, onClick, cls = '', r, tip }: { icon: string; label: ReactNode; onClick: () => void; cls?: string; r?: ReactNode; tip?: string }): ReactElement {
  return (
    <button className={'mi ' + cls} role="menuitem" data-tip={tip} onClick={onClick}>
      <Ic n={icon} s={15} />
      <span>{label}</span>
      {r != null ? <span className="r">{r}</span> : null}
    </button>
  );
}
const Hr = (): ReactElement => <div className="mhr" />;
const close = (): void => setUI({ menu: null });

function startRename(n: NodeT): void {
  if (isMobile()) {
    setUI({ menu: null, modal: { type: 'rename', id: n.id } });
    return;
  }
  if (n.parent_id) openMany([n.parent_id]);
  setUI({ menu: null, renaming: n.id, mTree: narrowMQ.matches });
}

function VersionsMenu({ id }: { id: string }): ReactElement {
  const n = useNode(id).data;
  const vs = useVersions(id);
  const viewing = useUI((s) => s.viewing);
  const cur = viewFor(n, viewing);
  return (
    <>
      {n?.has_draft ? (
        <button className={'mi' + (cur === 'draft' ? ' on' : '')} onClick={() => setUI({ viewing: 'draft', menu: null, editing: null })}>
          <span className="vn dr" style={{ width: 28, height: 20 }}>
            <Ic n="pencil" s={11} />
          </span>
          <span>Draft</span>
          <span className="r">{ago(n.updated_at)}</span>
        </button>
      ) : null}
      {(vs.data?.items ?? []).map((v) => (
        <button key={v.n} className={'mi' + (cur === v.n ? ' on' : '')} onClick={() => setUI({ viewing: v.n, menu: null, editing: null })}>
          <span className="vn" style={{ width: 28, height: 20 }}>
            v{v.n}
          </span>
          <span className="ell" style={{ maxWidth: 150 }}>
            {v.message ?? 'Update'}
          </span>
          <span className="r">
            {v.n === n?.published_version ? (
              <span style={{ color: 'var(--ok)' }}>
                <Ic n="check" s={14} />
              </span>
            ) : (
              ago(v.created_at)
            )}
          </span>
        </button>
      ))}
    </>
  );
}

function NewItems({ f }: { f: NodeT }): ReactElement {
  const inSkill = useInSkill(f);
  return (
    <>
      {newKinds(f, inSkill).map((k) => (
        <Mi key={k.act} icon={k.icon} label={k.tip} onClick={() => runNew(k.act, f.id)} />
      ))}
    </>
  );
}

function CtxMenu({ id }: { id: string }): ReactElement | null {
  const n = useNode(id).data;
  const p = useNode(n?.parent_id ?? null).data;
  if (!n) return null;
  const r = role(n);
  const pr = role(p);
  const fixed = n.is_area || n.name === 'SKILL.md';
  const isSkill = n.kind === 'folder' && !!n.is_skill && !n.is_area;
  const pend = n.skill?.pending ?? 0;
  const out: ReactElement[] = [];
  if (n.kind === 'folder') {
    if (r >= 2 && !isSkill) out.push(<NewItems key="new" f={n} />, <Hr key="h0" />);
    else if (r >= 2 && isSkill) out.push(<NewItems key="new" f={n} />, <Hr key="h0" />);
    if (isSkill && r >= 3 && pend)
      out.push(<Mi key="ps" icon="rocket" label="Publish skill" onClick={() => setUI({ menu: null, modal: { type: 'skill-publish', id: n.id, open: null } })} />);
  } else out.push(<Mi key="open" icon={n.format && n.format !== 'markdown' ? 'file-code' : 'file'} label="Open" onClick={() => void goNode(n.id)} />);
  if (r >= 2 && !fixed) out.push(<Mi key="rn" icon="type" label="Rename" onClick={() => startRename(n)} />);
  if (pr >= 4 && !fixed) out.push(<Mi key="mv" icon="move" label="Move" onClick={() => setUI({ menu: null, modal: { type: 'move', id: n.id, dest: null } })} />);
  if (n.kind === 'folder' && r >= 4 && !isSkill) out.push(<Mi key="sh" icon="user-plus" label="Share" onClick={() => setUI({ menu: null, modal: { type: 'share', id: n.id } })} />);
  if (!n.is_area)
    out.push(
      <Mi
        key="cp"
        icon="link"
        label="Copy [[link]]"
        onClick={() => {
          close();
          copyLink(n.canonical_path);
        }}
      />,
    );
  if (pr >= 4 && !fixed)
    out.push(
      <Hr key="h1" />,
      <Mi
        key="del"
        icon="trash"
        label="Delete"
        cls="dz"
        onClick={() => {
          close();
          void deleteNode(n.id);
        }}
      />,
    );
  return <>{trimHr(out)}</>;
}

function trimHr(xs: ReactElement[]): ReactElement[] {
  const out = [...xs];
  while (out.length && out[out.length - 1]!.type === Hr) out.pop();
  return out;
}

function MoreMenu({ id, mdoc }: { id: string; mdoc: boolean }): ReactElement | null {
  const n = useNode(id).data;
  const p = useNode(n?.parent_id ?? null).data;
  const me = useMe();
  const isSkillMd = n?.name === 'SKILL.md';
  // For SKILL.md the skill folder is the parent; its parent decides who may delete the skill.
  const skp = useNode(isSkillMd ? (p?.parent_id ?? null) : null).data;
  if (!n) return null;
  const r = role(n);
  const pr = role(p);
  const fixed = n.is_area || isSkillMd;
  const owner = me.data?.user.org_role === 'owner';
  const head = n.head_version ?? 0;
  const out: ReactElement[] = [];
  if (mdoc) {
    if (r >= 3 && head) out.push(<Mi key="pub" icon="rocket" label="Publish" onClick={() => setUI({ menu: null, modal: { type: 'publish', id: n.id, v: head } })} />);
    if (r >= 4 && n.parent_id) out.push(<Mi key="sh" icon="user-plus" label="Share" onClick={() => setUI({ menu: null, modal: { type: 'share', id: n.parent_id! } })} />);
    out.push(
      <Mi
        key="cp"
        icon="link"
        label="Copy [[link]]"
        onClick={() => {
          close();
          copyLink(n.canonical_path);
        }}
      />,
      <Hr key="h0" />,
    );
  }
  if (n.kind === 'doc') {
    if (head) out.push(<Mi key="cmp" icon="diff" label="Compare versions" onClick={() => setUI({ menu: null, modal: { type: 'diff', id: n.id, a: head > 1 ? head - 1 : 0, b: head } })} />);
    if (r >= 3 && n.published_version)
      out.push(
        <Mi
          key="unp"
          icon="eye-off"
          label={isSkillMd ? 'Unpublish skill' : 'Unpublish'}
          onClick={() => {
            close();
            void unpublish(n.id);
          }}
        />,
      );
  }
  if (r >= 2 && !fixed) out.push(<Mi key="rn" icon="type" label="Rename" onClick={() => startRename(n)} />);
  if (isSkillMd && p && role(p) >= 2) out.push(<Mi key="rns" icon="type" label="Rename skill" onClick={() => startRename(p)} />);
  if (pr >= 4 && !fixed) out.push(<Mi key="mv" icon="move" label="Move" onClick={() => setUI({ menu: null, modal: { type: 'move', id: n.id, dest: null } })} />);
  if (n.kind === 'folder' && owner) out.push(<Mi key="ex" icon="download" label="Export" onClick={() => setUI({ menu: null, modal: { type: 'export' } })} />);
  if (isSkillMd && p && role(skp) >= 4)
    out.push(
      <Hr key="h1" />,
      <Mi
        key="dels"
        icon="trash"
        label="Delete skill"
        cls="dz"
        onClick={() => {
          close();
          void deleteNode(p.id);
        }}
      />,
    );
  else if (pr >= 4 && !fixed)
    out.push(
      <Hr key="h1" />,
      <Mi
        key="del"
        icon="trash"
        label="Delete"
        cls="dz"
        onClick={() => {
          close();
          void deleteNode(n.id);
        }}
      />,
    );
  return <>{trimHr(out)}</>;
}

export function LintItem({ node, x, chip }: { node: string; x: { message: string; key: string; level: 'warn' | 'broken' }; chip?: boolean }): ReactElement {
  if (chip)
    return (
      <span className={'ln-i ' + x.level}>
        <Ic n={x.level === 'broken' ? 'link-off' : 'alert'} s={13} />
        <span>{x.message}</span>
        <button className="lx" aria-label="Dismiss" data-tip="Dismiss" onClick={() => void dismissWarning(node, x.key)}>
          <Ic n="x" s={12} />
        </button>
      </span>
    );
  return (
    <div className={'lint-i ' + x.level}>
      <Ic n={x.level === 'broken' ? 'link-off' : 'alert'} s={14} />
      <span className="grow">{x.message}</span>
      <button className="ib xs" aria-label="Dismiss" data-tip="Dismiss" onClick={() => void dismissWarning(node, x.key, true)}>
        <Ic n="x" s={13} />
      </button>
    </div>
  );
}

function LintMenu({ id }: { id: string }): ReactElement | null {
  const n = useNode(id).data;
  const viewing = useUI((s) => s.viewing);
  const v = n?.kind === 'doc' ? viewFor(n, viewing) : null;
  const w = useWarnings(id, v, !!n);
  if (!w.data) return null;
  const L = w.data.warnings;
  const ig = w.data.dismissed.length;
  return (
    <>
      {L.map((x) => (
        <LintItem key={x.key} node={id} x={x} />
      ))}
      {ig ? (
        <>
          {L.length ? <Hr /> : null}
          <Mi icon="undo" label={String(ig)} tip="Restore dismissed" onClick={() => void restoreWarnings(id)} />
        </>
      ) : null}
    </>
  );
}

function UserMenu(): ReactElement {
  const me = useMe();
  const u = me.data?.user;
  const owner = u?.org_role === 'owner';
  const goTo = (p: string): void => {
    setUI({ menu: null });
    navigate(p);
  };
  return (
    <>
      <div className="row-flex" style={{ padding: '8px 9px 10px' }}>
        <Av name={u?.name ?? u?.email} s={32} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 500 }}>{u?.name}</div>
          <div className="muted ell" style={{ fontSize: 12 }}>
            {u?.email}
          </div>
        </div>
      </div>
      <Hr />
      {owner ? (
        <>
          <Mi icon="user" label="People" onClick={() => goTo('/people')} />
          <Mi icon="users" label="Teams" onClick={() => goTo('/teams')} />
          <Mi icon="activity" label="Audit" onClick={() => goTo('/audit')} />
          <Hr />
        </>
      ) : null}
      <Mi icon="key" label="API tokens" onClick={() => goTo('/settings/tokens')} />
      <Mi icon="plug" label="Connections" onClick={() => goTo('/settings/connections')} />
      <Mi icon={isDark() ? 'sun' : 'moon'} label={isDark() ? 'Light' : 'Dark'} onClick={toggleTheme} />
      <Hr />
      <Mi icon="logout" label="Sign out" onClick={() => void logout()} />
    </>
  );
}

function NewMenu({ id }: { id: string }): ReactElement | null {
  const f = useNode(id).data;
  return f ? <NewItems f={f} /> : null;
}

function ActsMenu({ id }: { id: string }): ReactElement | null {
  const [t, x] = id.split(':') as [string, string];
  const users = useUsers(t === 'user');
  const tokens = useTokens();
  const conns = useConns();
  const trash = useTrash();
  if (t === 'user') {
    const u = users.data?.find((y) => y.id === x);
    if (!u) return null;
    const name = u.name ?? u.email ?? '';
    return u.status !== 'suspended' ? (
      <Mi icon="ban" label="Suspend" cls="dz" onClick={() => (close(), void setUserStatus(u.id, name, 'suspended'))} />
    ) : (
      <Mi icon="undo" label="Reactivate" onClick={() => (close(), void setUserStatus(u.id, name, 'active'))} />
    );
  }
  if (t === 'token') {
    const k = tokens.data?.items.find((y) => y.id === x);
    return k ? <Mi icon="trash" label="Revoke" cls="dz" onClick={() => (close(), void revokeToken(k.id, k.name))} /> : null;
  }
  if (t === 'conn') {
    const c = conns.data?.items.find((y) => y.id === x);
    return c ? <Mi icon="trash" label="Revoke" cls="dz" onClick={() => (close(), void revokeConn(c.id, connName(c)))} /> : null;
  }
  if (t === 'trash') {
    const n = trash.data?.items.find((y) => y.id === x);
    return n ? <Mi icon="undo" label="Restore" onClick={() => (close(), void restoreNode(n.id, n.name))} /> : null;
  }
  return null;
}

function MenuBody({ m }: { m: MenuState }): ReactElement | null {
  switch (m.type) {
    case 'versions':
      return <VersionsMenu id={m.id} />;
    case 'ctx':
      return <CtxMenu id={m.id} />;
    case 'more':
      return <MoreMenu id={m.id} mdoc={false} />;
    case 'mdoc':
      return <MoreMenu id={m.id} mdoc />;
    case 'lint':
      return <LintMenu id={m.id} />;
    case 'user':
      return <UserMenu />;
    case 'new':
      return <NewMenu id={m.id} />;
    case 'acts':
      return <ActsMenu id={m.id} />;
    default:
      return null;
  }
}

export function MenuHost(): ReactElement | null {
  const m = useUI((s) => s.menu);
  useUI((s) => s.theme);
  if (!m) return null;
  if (isMobile())
    return (
      <div className="modal-wrap">
        <div className="modal-scrim" onClick={close} />
        <div className="modal menu-sheet" role="menu">
          <div className="grab" aria-label="Resize" role="button" />
          <div className="modal-body">
            <MenuBody m={m} />
          </div>
        </div>
      </div>
    );
  const style: React.CSSProperties = { top: m.y, ...(m.right != null ? { right: m.right } : { left: m.x }) };
  return (
    <div className="menu" style={style} role="menu" data-menu="1">
      <MenuBody m={m} />
    </div>
  );
}
