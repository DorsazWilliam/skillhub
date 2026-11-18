/** Asset references: ![alt](asset://<id>) */
const ASSET_RE = /asset:\/\/([0-9A-HJKMNP-TV-Z]{26})/g;
/** Relative links to other documents: [text](./x.md) or (../a/b) */
const LINK_RE = /\[[^\]]*\]\((\.{1,2}\/[^)\s#]+)(?:#[^)\s]*)?\)/g;

export function assetIds(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(ASSET_RE)) if (m[1]) out.add(m[1]);
  return [...out];
}

export function relativeLinks(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(LINK_RE)) if (m[1]) out.add(m[1]);
  return [...out];
}

/** Resolves a relative link against a folder name path ('/A/B') into segments. */
export function resolveRelative(folderSegments: string[], href: string): string[] | null {
  const segs = [...folderSegments];
  for (const part of decodeURIComponent(href).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segs.length === 0) return null;
      segs.pop();
      continue;
    }
    segs.push(part.replace(/\.md$/i, ''));
  }
  return segs;
}

export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
