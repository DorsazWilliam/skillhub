---
name: hub-access
description: Use when asked who can see or edit a folder, or to share, unshare or restrict a folder in this hub.
license: internal
---

# Inspecting and changing access

Access is set on folders and flows down to everything inside, until a folder that does not inherit.

Roles, lowest to highest: viewer (read published), editor (drafts, versions), publisher (publish), manager (sharing, move, delete).

## Inspect

1. `effective_access` on the folder or document. Add `user` to check someone else (managers only).
2. `list_grants` on the folder. Rows with `inherited_from` come from a parent folder.
3. To see what a team can reach, `list_team_access`.

## Change

1. Say exactly what will change before doing it: who, which folder, which role, and that it applies to everything inside.
2. Confirm with the human before widening access (new person, higher role, `everyone`). Narrowing access you were asked to narrow needs no extra confirmation.
3. `grant_access` with `principal_type` `user` or `team`. Users are found by email. Use team `everyone` for the whole organization.
4. `revoke_access` removes a direct grant only. Inherited access must be removed on the parent, or cut with `set_inherit` `false`.
5. `set_inherit` `false` makes the folder a boundary: nothing from above applies. Check `list_grants` afterwards so the right people still have access.
6. Verify with `effective_access` and report the result.

## Rules

- Prefer teams over individual grants.
- Never grant manager to `everyone`.
- Never change access on `_hub`.
