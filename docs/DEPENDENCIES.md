# Dependencies

Only MIT, ISC, BSD and Apache-2.0 licensed packages are allowed. Check the license before adding a package and record it here.

## Web app (bundled into `web/dist`)

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| react, react-dom | 18.3.1 | MIT | UI |
| @tanstack/react-query | 5.108 | MIT | Server data cache over the generated client |
| @milkdown/crepe | 7.23 | MIT | WYSIWYG editor (builder + placeholder feature) |
| @milkdown/kit | 7.23 | MIT | ProseMirror, commonmark/GFM presets, plugins used by the editor extensions |
| @codemirror/state, view, commands, language, lang-markdown | 6.x | MIT | Raw markdown and text file editing |
| mdast-util-from-markdown, mdast-util-gfm, micromark-extension-gfm | 2.1 / 3.1 / 3.0 | MIT | Markdown parsing for the reading view (`web/src/lib/markdown.ts`) |
| Lucide icon paths (copied, no package) | | ISC | Icons, from the prototype |

Transitive check (November 2026, `node_modules` walk from the packages above): 215 packages, 211 MIT, 1 ISC, 1 BSD-2-Clause, 1 BSD-3-Clause, and `dompurify` (pulled in by `@milkdown/crepe`) under `MPL-2.0 OR Apache-2.0`, used under Apache-2.0.

Not used: Geist and Inter web fonts (OFL-1.1, and the CSP allows fonts from self only; see DECISIONS 34), Tailwind and shadcn/ui (DECISIONS 33), React Router (a small router instead).

## Development and test

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| vite | 8.3 | MIT | SPA build |
| @vitejs/plugin-react | 6.3 | MIT | JSX transform |
| @playwright/test | 1.65 | Apache-2.0 | End-to-end smoke suite and README screenshots |
| @types/react, @types/react-dom, @types/mdast | | MIT | Types |

The Worker's own dependencies (hono, zod, jose, yaml, diff, fflate, the MCP SDK, the OAuth provider, wrangler, vitest) predate this list; all are MIT, ISC or Apache-2.0. `@cloudflare/puppeteer` 2.0 (Apache-2.0) drives Browser Run for `render_prototype`.
