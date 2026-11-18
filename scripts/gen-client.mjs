// Writes web/src/api/client.ts from the operation registry.
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateClient } from './lib/client-gen.mjs';

const target = new URL('../web/src/api/client.ts', import.meta.url);
mkdirSync(new URL('.', target), { recursive: true });
writeFileSync(target, await generateClient());
console.log('wrote web/src/api/client.ts');
