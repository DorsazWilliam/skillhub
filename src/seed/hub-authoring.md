---
name: hub-authoring
description: Use when writing or editing a skill in this hub. Covers frontmatter, structure and what to leave out.
license: internal
---

# Writing a skill

A skill is instructions another agent will follow. Write for that agent, not for a human reader.

## Frontmatter

- `name`: lowercase letters, digits and hyphens. Max 64 characters. Unique enough to recognise in a list.
- `description`: one line that says **when** to use the skill, not what it is. Start with "Use when ...". Max 1024 characters, aim for under 160.
- Leave other keys (`license`, `compatibility`, `metadata`, `allowed-tools`) alone unless you know why they are there.
- A document without `name` and `description` is a plain document. It is readable but never returned by `find_skills`.

## Body

1. Lead with the outcome in one sentence.
2. Write numbered steps in the imperative: "Run", "Check", "Ask". No prose paragraphs.
3. State the stop conditions: when to ask the human, when to give up.
4. Keep the body under one screen. Push detail into linked documents: `[checklist](./checklist.md)`. Agents can follow those links with `get_skill`.
5. Use images only when a picture removes ambiguity. Insert them with `upload_asset`; never link external images.

## Never

- Secrets, tokens, passwords or internal URLs that grant access.
- Instructions that tell an agent to ignore other instructions, disable safety checks, or publish without review.
- Copies of another skill. Link to it instead.

## Before you commit

- Read the whole document once as the agent will see it.
- `diff_versions` against the published version and check every changed line is intended.
- Commit with a message that says why, not what: "Clarify rollback step for prod", not "update".
