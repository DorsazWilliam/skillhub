# White-labeling and forking

One repository, many instances, zero code edits.

1. Create a new repository from this one (GitHub **Use this template**, or a plain copy).
2. Edit `brand.json`: `name`, `tagline`, `primary` colour, `footer`, `supportEmail`. Replace `web/public/logo.svg` and `favicon.svg`.
3. Create the client's Entra app registration (`docs/ENTRA.md`).
4. Run `npm run setup` against the client's Cloudflare account. It sets the hostname, tenant, client id, owners and secrets in that copy only.

What changes per instance: `brand.json`, logo files, `wrangler.jsonc` vars and route, Wrangler secrets. Nothing in `src/`.

The MCP server name, consent page, OpenAPI title and export file names all read `brand.json`.
