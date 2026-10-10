import { useCallback, useState } from 'react';
import { Mascot3D } from './Mascot3D';

const characters = ['blue', 'pink', 'green'] as const;

/** Stable identity keeps each specialist recognizable across views and reloads. */
function characterFor(identity?: string) {
  if (!identity) return characters[0];
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return characters[hash % characters.length];
}

let webglSupport: boolean | null = null;
function webglAvailable() {
  if (webglSupport !== null) return webglSupport;
  try {
    if (typeof window === 'undefined' || !window.WebGLRenderingContext) {
      webglSupport = false;
      return webglSupport;
    }
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl')) as WebGL2RenderingContext | null;
    webglSupport = Boolean(gl);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

export function Mascot({
  state = 'idle',
  small = false,
  identity,
  name = 'Dot',
  decorative = false,
  render3d,
}: {
  state?: string;
  small?: boolean;
  identity?: string;
  name?: string;
  decorative?: boolean;
  /** Force (or forbid) the 3D avatar; defaults to large mascots only. */
  render3d?: boolean;
}) {
  const want3d = render3d ?? !small;
  const [use3d, setUse3d] = useState(
    () => want3d && webglAvailable(),
  );
  const handleUnsupported = useCallback(() => setUse3d(false), []);

  return (
    <span
      className={`mascot ${state} ${small ? 'small' : ''} ${
        use3d ? 'mascot-3d' : ''
      }`}
    >
      {use3d ? (
        <Mascot3D
          state={state}
          identity={identity}
          onUnsupported={handleUnsupported}
        />
      ) : (
        <>
          <svg width="0" height="0" aria-hidden="true" focusable="false">
            <filter id="dot-goo">
              <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
              <feColorMatrix
                in="blur"
                mode="matrix"
                values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9"
                result="goo"
              />
            </filter>
          </svg>
          <span className="blob-group" aria-hidden="true">
            <i className="blob" />
            <i className="blob" />
            <i className="blob" />
          </span>
          <img
            className="dot-body"
            src={`/dots/${characterFor(identity)}.png`}
            alt={decorative ? '' : `${name} is ${state}`}
            width={512}
            height={512}
            draggable={false}
          />
        </>
      )}
    </span>
  );
}
