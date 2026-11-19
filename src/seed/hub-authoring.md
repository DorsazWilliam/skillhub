---
name: hub-authoring
description: Use when writing or editing a rule, skill or document in this hub. Covers where things go, frontmatter, links and warnings.
license: internal
---

# Writing for the hub

Everything here is instructions another agent will follow. Write for that agent, not for a human reader.

## Where things go

- `rules/`: short rules every agent receives when it connects. Markdown only, no folders. All published rules together must stay under 8 KB.
- `skills/`: one folder per skill, holding a `SKILL.md` plus its templates (markdown) and scripts (`.sh`, `.py`, `.sql` and other text files). Create one with `create_skill`. A skill folder inside another skill is a sub-skill.
- `documentation/`: reference material that skills and rules link to.

## Frontmatter of SKILL.md

- `name`: lowercase letters, digits and hyphens. Max 64 characters. Same as the folder name.
- `description`: one line in the third person that says **when** to use the skill. Start with "Use when ...". Max 1024 characters, aim for under 160.
- Leave other keys (`license`, `compatibility`, `metadata`, `allowed-tools`) alone unless you know why they are there.

## Body

1. Lead with the outcome in one sentence.
2. Write numbered steps in the imperative: "Run", "Check", "Ask". No prose paragraphs.
3. State the stop conditions: when to ask the human, when to give up.
4. Keep SKILL.md under one screen. Push detail into files of the skill and link them one level deep.
5. Use images only when a picture removes ambiguity. Insert them with `upload_asset`; never link external images.

## Links

- Link with the canonical path, without `.md`: `[[documentation/engineering/feature-flags]]`, `[[skills/deploy-service/scripts/smoke-test.sh|the smoke test]]`.
- Rules link to skills and documentation. Skills link to documentation and to their own files and sub-skills. Documentation links to documentation.
- `get_links` shows each link as ok, wrong_direction, broken or locked.

## Warnings

`update_draft`, `commit_version`, `publish_version` and `publish_skill` return `warnings` checked against these guidelines. They never block a save. Fix each one, or tell the human why it should stay, before committing. Dismiss a warning with `dismiss_warning` only when the human agrees.

## Never

- Secrets, tokens, passwords or internal URLs that grant access.
- Instructions that tell an agent to ignore other instructions, disable safety checks, or publish without review.
- Copies of another skill. Link to it instead.

## Before you commit

- Read the whole document once as the agent will see it.
- `diff_versions` against the published version and check every changed line is intended.
- Commit with a message that says why, not what: "Clarify rollback step for prod", not "update".
