---
name: hub-promote
description: Use when asked to commit, publish, promote or roll back a skill version in this hub.
license: internal
---

# Promoting a skill version

Publishing changes what every agent in the organization reads. Treat it like a production deploy.

## Steps

1. `get_skill` on the skill (or `get_node` on a single document). Note `published_version` and, for each file, `head_version`.
2. If there is a draft you are asked to promote, `get_draft` and read it in full.
3. `diff_versions` with `from: "published"` and `to: "draft"` (or the version number). Show the diff to the human.
4. Check the frontmatter: `name` is lowercase-hyphenated, `description` says when to use the skill.
5. `commit_version` with a message that explains why the change was made. Note the returned version number.
6. Ask the human to confirm publishing that version number, unless they already told you to publish without asking.
7. `publish_skill` on the skill folder to publish every changed file of the skill at once, or `publish_version` with that number for a single document.
8. Verify with `get_skill` that `version` equals the number you published.
9. Report: path, versions published, previous versions, and any `warnings` returned.

## Rolling back

Rolling back is publishing an older version. `list_versions`, pick the last good one, show the diff from the current published version, then `publish_version` with the older number. Never delete versions.

## Rules

- Never publish without showing the diff to the human, unless explicitly told to.
- Never publish a document you did not read in full.
- One skill per publish. Do not batch unrelated documents.
- Commit every file you changed before `publish_skill`: it publishes committed versions only and reports files that still have a draft.
- Always report the version number you published.
- If `commit_version` or `update_draft` returns `conflict`, someone else edited the draft. Stop, show the human the current draft, and ask how to proceed.
- If a call returns `scope_required`, tell the human which scope is missing. Do not look for workarounds.
