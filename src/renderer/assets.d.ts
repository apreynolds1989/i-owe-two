// Image imports resolve to a URL that Vite emits next to the bundle.
declare module '*.png' {
  const src: string;
  export default src;
}

// Stylesheets are imported for their side effect only (Vite bundles them); there's nothing to type.
declare module '*.css';
