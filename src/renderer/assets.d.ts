// Image imports resolve to a URL that Vite emits next to the bundle.
declare module '*.png' {
  const src: string;
  export default src;
}
