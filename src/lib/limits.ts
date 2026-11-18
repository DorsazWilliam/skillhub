export const LIMITS = {
  docBytes: 256 * 1024,
  imageBytes: 5 * 1024 * 1024,
  mcpImageBytes: 1024 * 1024,
  folderDepth: 12,
  nameChars: 120,
  moveNodes: 5000,
  pageSize: 100,
  catalogEntries: 25,
  catalogBytes: 4096,
} as const;

export const NOW = (): number => Date.now();
