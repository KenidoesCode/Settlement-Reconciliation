/**
 * Ambient declarations for non-code imports.
 *
 * TypeScript 6 reports TS2882 for a side-effect import with no type
 * declaration, and Next's generated next-env.d.ts does not cover stylesheets.
 */
declare module "*.css";
