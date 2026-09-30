/**
 * Getting a model onto the GPU before it is looked at.
 *
 * The first frame a newly loaded model is drawn in, the renderer uploads its
 * textures and compiles its shaders — synchronously, inside that frame. For a
 * textured airframe or cockpit that was a quarter to half a second with the
 * picture frozen, exactly at the moment the view changed. Here the same work
 * is done while the model is still hidden: shaders through the parallel
 * compile extension (`compileAsync`, which does not block), and textures a
 * few per frame, so no single frame carries all of them.
 */

import { PerspectiveCamera, type Material, type Object3D, type Scene, type Texture, type WebGLRenderer } from 'three';

const camera = new PerspectiveCamera();
/** Decoded already (see `library.ts`), an upload is a few milliseconds: three fit in a frame. */
const TEXTURES_PER_FRAME = 3;

function texturesOf(root: Object3D): Texture[] {
  const out = new Set<Texture>();
  root.traverse((o) => {
    const material = (o as { material?: Material | Material[] }).material;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) {
      for (const value of Object.values(m)) if (value && (value as Texture).isTexture) out.add(value as Texture);
    }
  });
  return [...out];
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Upload `root`'s textures and compile its shaders, lit as `scene` lights it.
 * Resolves when it is ready to be drawn without a stall; never rejects.
 */
export async function prewarm(renderer: WebGLRenderer, root: Object3D, scene: Scene): Promise<void> {
  try {
    await renderer.compileAsync(root, camera, scene);
  } catch {
    // An old driver without the extension: the first draw compiles instead.
  }
  let n = 0;
  for (const texture of texturesOf(root)) {
    renderer.initTexture(texture);
    if (++n % TEXTURES_PER_FRAME === 0) await nextFrame();
  }
}
