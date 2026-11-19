import { useEffect, type ReactElement } from 'react';
import { useNode, useChain, fetchChildren, type NodeT } from '../api/hooks';
import { navigate, type Route } from '../router';
import { noteVisit } from '../actions';
import { HomePage, FolderPage } from '../pages/Folder';
import { DocPage } from '../pages/Doc';
import { Empty, Spinner } from '../ui/common';
import { GraphPage } from '../pages/Graph';
import { SearchPage } from '../pages/SearchPage';
import { PeoplePage, TeamsPage, TeamPage, AuditPage, TokensPage, ConnectionsPage, TrashPage } from '../pages/Admin';
import { ApiError } from '../api/client';

/**
 * Resolves /n/:id. A skill folder opens its SKILL.md (prototype goNode); a path or canonical path is replaced by the id.
 * Returns the node once it is the one to show.
 */
export function useResolvedNode(routeId: string): { node: NodeT | undefined; error: unknown } {
  const q = useNode(routeId);
  const n = q.data;
  const chain = useChain(n && n.id === routeId ? n.id : null);
  useEffect(() => {
    if (!n) return;
    if (n.id !== routeId) {
      navigate('/n/' + n.id, { replace: true });
      return;
    }
    if (n.kind === 'folder' && n.is_skill && !n.is_area) {
      let live = true;
      void fetchChildren(n.id).then((kids) => {
        const md = kids.find((k) => k.kind === 'doc' && k.name === 'SKILL.md');
        if (live && md) navigate('/n/' + md.id, { replace: true });
      });
      return () => {
        live = false;
      };
    }
    return undefined;
  }, [n, routeId]);
  useEffect(() => {
    if (!n || n.id !== routeId || !chain.data) return;
    const folders = chain.data.filter((x) => x.kind === 'folder').map((x) => x.id);
    if (n.kind === 'doc') noteVisit(n.id, folders);
    else noteVisit('', folders);
  }, [n, routeId, chain.data]);
  const ready = n && n.id === routeId && !(n.kind === 'folder' && n.is_skill && !n.is_area);
  return { node: ready ? n : undefined, error: q.error };
}

function NodePage({ id }: { id: string }): ReactElement {
  const { node, error } = useResolvedNode(id);
  if (!node)
    return (
      <div className="page">
        {error ? (
          <Empty icon={error instanceof ApiError && error.status === 404 ? 'lock' : 'alert'}>
            <span className="muted">{error instanceof ApiError && error.status === 404 ? 'Not found or no access' : 'Could not load'}</span>
          </Empty>
        ) : (
          <Spinner />
        )}
      </div>
    );
  return node.kind === 'doc' ? <DocPage key={node.id} id={node.id} /> : <FolderPage key={node.id} id={node.id} />;
}

export function Main({ route }: { route: Route }): ReactElement {
  switch (route.name) {
    case 'node':
      return <NodePage id={route.id} />;
    case 'graph':
      return <GraphPage focus={route.focus} />;
    case 'search':
      return <SearchPage q={route.q} />;
    case 'people':
      return <PeoplePage />;
    case 'teams':
      return <TeamsPage />;
    case 'team':
      return <TeamPage id={route.id} />;
    case 'audit':
      return <AuditPage />;
    case 'tokens':
      return <TokensPage />;
    case 'connections':
      return <ConnectionsPage />;
    case 'trash':
      return <TrashPage />;
    default:
      return <HomePage />;
  }
}
