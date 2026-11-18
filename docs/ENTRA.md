# Microsoft Entra setup

SkillHub signs people in with Entra ID only. You need one app registration. About 5 minutes.

## 1. Register the app

1. Go to **Microsoft Entra admin center > Identity > Applications > App registrations > New registration**.
2. **Name**: the hub name, e.g. `SkillHub`.
3. **Supported account types**:
   - Single tenant (default): *Accounts in this organizational directory only*.
   - Multi-tenant: *Accounts in any organizational directory*. Then set `ENTRA_ALLOWED_TENANTS` to the tenant ids you accept. Tokens from any other tenant are refused.
4. **Redirect URI**: platform **Web**, value `https://<your-host>/auth/callback`.
5. Register.

## 2. Copy ids

From **Overview** copy:

- **Directory (tenant) ID** -> `ENTRA_TENANT_ID`
- **Application (client) ID** -> `ENTRA_CLIENT_ID`

## 3. Client secret

1. **Certificates & secrets > Client secrets > New client secret**.
2. Choose an expiry (Microsoft maximum is 24 months). Put a reminder in your calendar a month before.
3. Copy the **Value** (not the Secret ID). It is shown once.
4. Store it as a Wrangler secret, never in a file:

```powershell
npx wrangler secret put ENTRA_CLIENT_SECRET
```

## 4. Token configuration (optional but recommended)

**Token configuration > Add optional claim > ID > `email`**. Without it SkillHub falls back to `preferred_username`. Email is only used for display, owner bootstrap and the optional domain filter. Identity is always `(tid, oid)`.

No API permissions beyond the defaults are needed. SkillHub requests `openid profile email` and makes no Microsoft Graph calls.

## Rotating the secret

1. Create a second client secret in the portal (both stay valid until expiry).
2. `npx wrangler secret put ENTRA_CLIENT_SECRET` with the new value. Takes effect on the next request; no redeploy needed.
3. Sign in once to confirm, then delete the old secret in the portal.

## Guests and domains

- Guest accounts (B2B) are refused unless `ALLOW_GUESTS=true`.
- `ALLOWED_EMAIL_DOMAINS` can only narrow who gets in; it never lets anyone in.
- Owners are bootstrapped from `OWNER_EMAILS` on their first sign-in only. After that, owners promote others in **People**.
