import { describe, it, expect } from 'vitest';
import { AzureBlobBucket } from '../src/node/azure';

/**
 * The Azure Blob adapter against Azurite (the official emulator). Runs only with AZURITE_URL set, on the Node test run:
 *   docker run -d -p 10000:10000 mcr.microsoft.com/azure-storage/azurite:3.35.0 azurite-blob --blobHost 0.0.0.0
 *   AZURITE_URL=http://127.0.0.1:10000/devstoreaccount1 npm run test:node -- test/azure.test.ts
 */
const url = typeof process !== 'undefined' ? process.env?.['AZURITE_URL'] : undefined;
// Azurite's published development account key.
const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

describe.skipIf(!url)('Azure Blob adapter (Azurite)', () => {
  it('put, get, head, list with a cursor, delete', async () => {
    const b = new AzureBlobBucket({ account: 'devstoreaccount1', container: 't' + Date.now(), endpoint: url, key: KEY });
    await b.ensureContainer();
    await b.ensureContainer();
    await b.put('renders/a b.png', new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/png' }, customMetadata: { proto: 'P1', mode: 'working' } });
    await b.put('renders/c.png', 'hello');
    await b.put('assets/x', 'x');
    const got = (await b.get('renders/a b.png')) as { size: number; customMetadata: Record<string, string>; httpMetadata: { contentType: string }; arrayBuffer: () => Promise<ArrayBuffer> };
    expect(got.size).toBe(3);
    expect(got.customMetadata).toEqual({ proto: 'P1', mode: 'working' });
    expect(got.httpMetadata.contentType).toBe('image/png');
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(await b.get('missing')).toBeNull();
    expect(((await b.head('renders/c.png')) as { size: number }).size).toBe(5);
    const p1 = (await b.list({ prefix: 'renders/', limit: 1 })) as { objects: { key: string }[]; truncated: boolean; cursor?: string };
    expect(p1.objects.map((o) => o.key)).toEqual(['renders/a b.png']);
    expect(p1.truncated).toBe(true);
    const p2 = (await b.list({ prefix: 'renders/', limit: 1, cursor: p1.cursor })) as { objects: { key: string }[]; truncated: boolean };
    expect(p2.objects.map((o) => o.key)).toEqual(['renders/c.png']);
    await b.delete(['renders/a b.png', 'renders/c.png']);
    expect(((await b.list({ prefix: 'renders/' })) as { objects: unknown[] }).objects).toEqual([]);
  });
});
