import { defineConfig } from 'orval'

export default defineConfig({
  contract: {
    input: {
      target: 'backend/API-CONTRACT.yaml',
    },
    output: {
      target: 'packages/contract/src/generated/endpoints',
      schemas: 'packages/contract/src/generated/model',
      client: 'fetch',
      mode: 'tags-split',
      indexFiles: true,
      mock: {
        generators: [{ type: 'msw' }],
      },
      prettier: true,
      clean: true,
    },
  },
})