import type { ReactElement } from 'react';
import { Ic } from '../lib/icons';

/** Unified patch (from diff_versions) to the prototype's side-by-side-numbered diff table with collapsed gaps. */

export interface Op {
  t: ' ' | '+' | '-' | 'g';
  a?: number;
  b?: number;
  s: string;
  gap?: number;
}

export function parsePatch(patch: string): Op[] {
  const out: Op[] = [];
  let a = 0;
  let b = 0;
  let lastA = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      // A side with length 0 names the line before the change; numbering starts after it.
      a = Number(h[2] ?? '1') === 0 ? Number(h[1]) + 1 : Number(h[1]);
      b = Number(h[4] ?? '1') === 0 ? Number(h[3]) + 1 : Number(h[3]);
      const gap = a - lastA - 1;
      if (gap > 0) out.push({ t: 'g', s: '', gap });
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\') || line === '') continue;
    const c = line[0];
    const s = line.slice(1);
    if (c === '+') out.push({ t: '+', b: b++, s });
    else if (c === '-') {
      lastA = a;
      out.push({ t: '-', a: a++, s });
    } else if (c === ' ') {
      lastA = a;
      out.push({ t: ' ', a: a++, b: b++, s });
    }
  }
  return out;
}

/** All lines added (diff against nothing). */
export function addAll(text: string): Op[] {
  const lines = text.replace(/\n$/, '').split('\n');
  return lines.map((s, i) => ({ t: '+', b: i + 1, s }));
}

export function Stat({ add, del }: { add: number; del: number }): ReactElement {
  return (
    <span className="stat">
      <span className="p">+{add}</span>
      <span className="m">-{del}</span>
    </span>
  );
}

export function DiffTable({ ops }: { ops: Op[] }): ReactElement {
  if (!ops.some((o) => o.t === '+' || o.t === '-'))
    return (
      <div className="empty" style={{ padding: '30px 0' }}>
        <Ic n="check" s={20} />
        <span>Identical</span>
      </div>
    );
  return (
    <div className="diff">
      <table>
        <tbody>
          {ops.map((o, i) =>
            o.t === 'g' ? (
              <tr key={i} className="g">
                <td colSpan={3}>
                  <Ic n="more" s={14} style={{ display: 'inline-block', verticalAlign: 'middle' }} /> {o.gap}
                </td>
              </tr>
            ) : (
              <tr key={i} className={o.t === '+' ? 'a' : o.t === '-' ? 'd' : ''}>
                <td className="n">{o.a ?? ''}</td>
                <td className="n">{o.b ?? ''}</td>
                <td className="c">
                  <span className="sg">{o.t === ' ' ? '' : o.t}</span>
                  {o.s || ' '}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
