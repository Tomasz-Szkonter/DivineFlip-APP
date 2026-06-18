import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// base: './' so the build works from a GitHub Pages project subpath
// (https://user.github.io/divineflip/) and data is fetched with a relative path.
export default defineConfig({
  base: './',
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
  },
});
