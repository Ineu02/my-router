/**
 * WebGL capability probe.
 *
 * Cheap, synchronous, and side-effect free: create a throwaway canvas, try for
 * a context, discard it. If this returns false the dashboard renders the DOM
 * topology fallback instead of booting Three.js — no half-initialised scene, no
 * thrown constructor.
 */
export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl');
    return gl instanceof WebGLRenderingContext || gl instanceof WebGL2RenderingContext;
  } catch {
    return false;
  }
}
