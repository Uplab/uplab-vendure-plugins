#!/usr/bin/env node
/**
 * Copies a package's dashboard extension (`src/dashboard` in the current directory) to
 * `dist/dashboard`, leaving unit specs behind. The sources ship as `.tsx`: the host's Vite compiles them.
 */
import { cpSync } from 'node:fs';

cpSync('src/dashboard', 'dist/dashboard', {
  recursive: true,
  filter: (source) => !/\.spec\.tsx?$/.test(source),
});
