# Sign-in and invitations

Turn on any combination of sign-in methods with `AUTH_PROVIDERS` (comma separated). The sign-in page shows the ones that are on.

| Method | `AUTH_PROVIDERS` | Settings | Who is a member |
| --- | --- | --- | --- |
| Microsoft Entra ID | `microsoft` (default) | `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `ENTRA_ALLOWED_TENANTS`, `ALLOW_GUESTS` (docs/ENTRA.md) | Users of the allowed tenants (guests only with `ALLOW_GUESTS=true`) |
| Google | `google` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_DOMAINS` | Accounts of the Workspace domains in `GOOGLE_DOMAINS` |
| Your identity server (Keycloak, Okta, Authentik, ADFS, any OpenID Connect provider) | `oidc` | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME` (button label), `OIDC_SCOPES` | Every user of that server |
| Email link, then passkeys | `email` | `ALLOWED_EMAIL_DOMAINS`, and an email sender (below) | Addresses in `ALLOWED_EMAIL_DOMAINS` |

`ALLOWED_EMAIL_DOMAINS`, when set, also restricts members of every other method. The redirect URI to register with Microsoft, Google or your server is `<BASE_URL>/auth/callback`.

Everyone else gets in only with an invitation.

## Invitations

Anyone who manages a folder can invite an email address to it: in Share, type the address and choose Invite (or `create_invitation` over REST and MCP, which can also add teams). The person gets an email with a link valid for 14 days; without an email sender, the inviter gets the link to send themselves.

The invited person signs in with any enabled method using that email address, or, when email sign-in is on, with "Continue as" on the invitation page (the link itself proves the address). They get the access the invitation carries. Someone outside the organization becomes an **external** user: marked on People, and never an owner. Pending invitations are listed on People, where they can be cancelled. Turn invitations off with `ALLOW_INVITES=false`.

## Email sign-in and passkeys

With `email` on, the sign-in page asks for an address and sends a one-time link (15 minutes; a confirmation click, so mail scanners cannot use it up). Every address gets the same answer, so the page never reveals who has an account.

Once signed in, people add passkeys under API tokens (fingerprint, face, device PIN) and sign in with one tap after that. Passkeys are on only when email sign-in is on: an organization that signs in through Microsoft or its own server keeps that as the only way in.

## Email sender

| `EMAIL_TRANSPORT` | Settings | Where |
| --- | --- | --- |
| `smtp` | `SMTP_URL` (`smtp://user:pass@host:587` or `smtps://...`) | Docker image |
| `resend` | `RESEND_API_KEY` | Anywhere |
| `log` | none: messages are printed | Local development (default with `DEV_LOGIN`) |

`EMAIL_FROM` sets the sender (default `<brand> <no-reply@<host>>`). Without a sender, email sign-in is hidden and invitations show their link instead of sending it.

## Identity

People are keyed on the method and that method's user id: the Entra tenant and object id as before, `google` and the Google subject, `oidc:<issuer>` and the subject, `email` and the address. The same person signing in with two methods gets two accounts. Owners come from `OWNER_EMAILS` on a member's first sign-in.
