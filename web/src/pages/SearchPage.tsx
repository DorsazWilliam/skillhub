import type { ReactElement } from 'react';
import { Ic } from '../lib/icons';
import { navigate } from '../router';
import { goNode } from '../actions';
import { SearchResults } from '../shell/search';

/** /search?q= deep link: the dropdown results as a page. */
export function SearchPage({ q }: { q: string }): ReactElement {
  return (
    <div className="page">
      <div className="ph1">
        <h1>Search</h1>
        <div className="grow" />
        <div className="qwrap" style={{ maxWidth: 420 }}>
          <Ic n="search" s={15} />
          <input
            className="input"
            id="search-q"
            placeholder="Search"
            defaultValue={q}
            autoComplete="off"
            spellCheck={false}
            aria-label="Search"
            onChange={(e) => navigate('/search?q=' + encodeURIComponent(e.target.value), { replace: true })}
          />
        </div>
      </div>
      {q.trim() ? (
        <div className="sres-page">
          <SearchResults q={q} sIdx={-1} onPick={(id) => void goNode(id)} />
        </div>
      ) : (
        <div className="empty">
          <span className="eic">
            <Ic n="search" s={22} />
          </span>
        </div>
      )}
    </div>
  );
}
