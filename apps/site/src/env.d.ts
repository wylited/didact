// Virtual modules served by build-time plugins (apps/site/typst/vite.ts).
declare module 'virtual:didact-typst' {
  import type { TypstArtifacts } from '@didact/core';
  const artifacts: TypstArtifacts;
  export default artifacts;
}
