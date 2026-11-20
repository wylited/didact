// Raw-text asset imports (Vite's `?raw`). apps/site typechecks this package
// through its own tsconfig, which carries the vite/client ambient types;
// this file keeps the package self-describing for any other checker.
declare module '*.py?raw' {
  const content: string;
  export default content;
}
