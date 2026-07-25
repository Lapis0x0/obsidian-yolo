import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './runtime-components/pglite-engine/src/schema.ts',
})
