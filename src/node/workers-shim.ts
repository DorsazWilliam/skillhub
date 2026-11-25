/**
 * Stand-in for the `cloudflare:workers` module on Node. The OAuth provider only imports WorkerEntrypoint to tell
 * entrypoint classes from plain handlers; SkillHub passes plain handlers.
 */
export class WorkerEntrypoint {}
export const env = {};
