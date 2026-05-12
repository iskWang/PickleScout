# API Route Template (Fastify)

```typescript
import { FastifyInstance, FastifyPluginOptions } from 'fastify';

export default async function featureRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions
) {
  fastify.post('/jobs', {
    schema: {
      body: {
        type: 'object',
        required: ['url', 'llm'],
        properties: {
          url: { type: 'string', format: 'uri' },
          hint: { type: 'string' },
          llm: {
            type: 'object',
            required: ['provider', 'apiKey', 'model'],
            properties: {
              provider: { type: 'string', enum: ['openai', 'openrouter', 'anthropic', 'gemini', 'custom'] },
              apiKey: { type: 'string' },
              model: { type: 'string' },
            }
          }
        }
      }
    },
    handler: async (request, reply) => {
      const body = request.body as any;
      // Implementation...
      return { hash: '...' };
    }
  });
}
```
