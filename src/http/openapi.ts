import brand from '../../brand.json';
import { OPS } from '../registry';
import { opSchemas, pathParams, type JsonSchema } from './schema';

const ERROR = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', enum: ['forbidden', 'not_found', 'conflict', 'scope_required', 'invalid', 'unauthenticated', 'rate_limited', 'internal'] },
        message: { type: 'string' },
        details: { type: 'object' },
      },
      required: ['code', 'message'],
    },
  },
};

/** OpenAPI 3.1 document generated from the operation registry. */
export function openapi(baseUrl: string): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPS) {
    if (!op.rest) continue;
    const { input, output } = opSchemas(op);
    const props = (input['properties'] ?? {}) as Record<string, JsonSchema>;
    const required = new Set((input['required'] ?? []) as string[]);
    const inPath = pathParams(op.rest.path);
    const method = op.rest.method.toLowerCase();
    const queryish = method === 'get' || method === 'delete';
    const parameters = [
      ...inPath.map((name) => ({ name, in: 'path', required: true, schema: props[name] ?? { type: 'string' } })),
      ...(queryish
        ? Object.entries(props)
            .filter(([k]) => !inPath.includes(k))
            .map(([name, schema]) => ({ name, in: 'query', required: required.has(name), schema }))
        : []),
    ];
    const bodyProps = Object.fromEntries(Object.entries(props).filter(([k]) => !inPath.includes(k)));
    const bodyRequired = [...required].filter((k) => !inPath.includes(k));
    const body = { type: 'object', properties: bodyProps, ...(bodyRequired.length ? { required: bodyRequired } : {}), additionalProperties: false };
    const requestBody = queryish
      ? undefined
      : op.rest.multipart
        ? {
            required: true,
            content: {
              'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, alt: { type: 'string' } }, required: ['file'] } },
              'application/json': { schema: body },
            },
          }
        : { required: bodyRequired.length > 0, content: { 'application/json': { schema: body } } };
    const p = op.rest.path;
    paths[p] ??= {};
    paths[p][method] = {
      operationId: op.name,
      summary: op.summary,
      tags: [op.scope],
      'x-scope': op.scope,
      parameters,
      ...(requestBody ? { requestBody } : {}),
      responses: {
        '200': { description: 'OK', content: { 'application/json': { schema: output } } },
        default: { description: 'Error', content: { 'application/json': { schema: ERROR } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: `${brand.name} API`, version: '1.0.0', description: brand.tagline },
    servers: [{ url: `${baseUrl}/api/v1` }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'Personal access token (shp_...)' },
        session: { type: 'apiKey', in: 'cookie', name: '__Host-skillhub_session' },
      },
    },
    security: [{ bearer: [] }, { session: [] }],
    paths,
  };
}
