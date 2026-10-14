import { useEffect, useRef, useState } from 'react';
import {
  AVATAR_IDS,
  avatarSrc,
  avatarStateSrc,
  hasValidateOverlay,
} from '../shared/avatars';

const characters = ['blue', 'pink', 'green'] as const;
export const AVATARS = AVATAR_IDS;
export type Avatar = (typeof AVATARS)[number];

/** Stable identity keeps each specialist recognizable across views and reloads. */
function characterFor(identity?: string) {
  if (!identity) return characters[0];
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return characters[hash % characters.length];
}

function avatarFile(avatar: string | null | undefined, identity?: string) {
  if (avatar && (AVATARS as readonly string[]).includes(avatar)) return avatar;
  return characterFor(identity);
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

interface Spring {
  x: number;
  v: number;
  t: number;
  k: number;
  d: number;
}
const spring = (k: number, d: number): Spring => ({ x: 0, v: 0, t: 0, k, d });
const step = (s: Spring, dt: number) => {
  s.v += (s.k * (s.t - s.x) - s.d * s.v) * dt;
  s.x += s.v * dt;
};

/**
 * Animated Dot avatar. Body motion is driven by a single requestAnimationFrame
 * loop with damped springs (lean toward the pointer, idle bob, click hop). The
 * loop only runs while the element is visible and when motion is allowed.
 *
 * When an avatar ships per-state clips (an animated WebP per mascot state) the
 * live body crossfades between two stacked <img> layers on each state change,
 * so the switch is seamless (the outgoing clip keeps playing while it fades).
 */
export function Mascot({
  state = 'idle',
  small = false,
  identity,
  name = 'Dot',
  decorative = false,
  avatar,
  animate,
}: {
  state?: string;
  small?: boolean;
  identity?: string;
  name?: string;
  decorative?: boolean;
  avatar?: string | null;
  /** Force body animation even for small avatars (defaults to !small). */
  animate?: boolean;
}) {
  const layersRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const live = animate ?? !small;

  const character = avatarFile(avatar, identity);
  const baseSrc = avatarSrc(character) ?? `/dots/${character}.png`;
  const wanted = (live && avatarStateSrc(character, state)) || baseSrc;

  // One visible layer at rest; a second layer only exists during the short
  // crossfade. Two always-mounted copies of the same animated WebP drift out
  // of sync (double image / ghosting) and double the decode cost.
  const [shown, setShown] = useState(baseSrc);
  const [incoming, setIncoming] = useState<string | null>(null);
  const activeSrc = useRef(baseSrc);
  const fadeTimer = useRef<number | undefined>(undefined);
  const alt = decorative ? '' : `${name} is ${stateRef.current}`;

  // Crossfade to the state clip once it is decoded (never shows a blank frame).
  useEffect(() => {
    if (!live || wanted === activeSrc.current) return;
    const next = wanted;
    const img = new Image();
    let cancelled = false;
    const commit = () => {
      if (cancelled || next === activeSrc.current) return;
      setIncoming(next);
      window.clearTimeout(fadeTimer.current);
      fadeTimer.current = window.setTimeout(() => {
        activeSrc.current = next;
        setShown(next);
        setIncoming(null);
      }, 360);
    };
    img.onload = commit;
    img.onerror = commit;
    img.src = next;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [wanted, live]);

  useEffect(() => () => window.clearTimeout(fadeTimer.current), []);

  useEffect(() => {
    if (!live) return;
    const layers = layersRef.current;
    const root = rootRef.current;
    if (!layers || !root) return;
    // Honour reduced-motion by calming the movement, not freezing the avatar.
    const calm =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    const gain = calm ? 0.35 : 1;
    const S = {
      lookX: spring(90, 13),
      lookY: spring(90, 13),
      squash: spring(220, 12),
      hop: spring(180, 7),
      tilt: spring(70, 11),
    };
    let frame = 0;
    let last = performance.now();
    let pointer: { x: number; y: number; t: number } | null = null;
    let center: { x: number; y: number } | null = null;
    // Measure the mascot centre only when it may have moved (pointer, resize,
    // scroll) instead of forcing a layout read on every animation frame.
    const measure = () => {
      const r = root.getBoundingClientRect();
      center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const onMove = (event: PointerEvent) => {
      measure();
      pointer = { x: event.clientX, y: event.clientY, t: performance.now() };
    };
    const onDown = () => {
      measure();
      S.hop.v -= 42 * gain;
      S.squash.v += 7 * gain;
    };
    const visible = () => !document.hidden && root.getClientRects().length > 0;
    const loop = (now: number) => {
      const dt = Math.min(50, now - last) / 1000;
      last = now;
      const mode = stateRef.current;
      let lx = 0.4 * Math.sin(now / 2600);
      let ly = 0.2 * Math.sin(now / 3700);
      if (pointer && center && now - pointer.t < 6000) {
        lx = clamp((pointer.x - center.x) / 420, -1, 1);
        ly = clamp((pointer.y - center.y) / 420, -1, 1);
      }
      let bob = Math.sin(now / 1400) * 3;
      let tiltT = 0;
      if (mode === 'listening') bob = Math.sin(now / 700) * 2.2;
      else if (
        mode === 'working' ||
        mode === 'thinking' ||
        mode === 'searching'
      )
        tiltT = 0.035 * Math.sin(now / 900);
      else if (mode === 'writing') bob = -Math.abs(Math.sin(now / 320)) * 3.5;
      else if (mode === 'complete') bob = Math.sin(now / 220) * 4;
      S.lookX.t = lx;
      S.lookY.t = ly;
      S.tilt.t = tiltT;
      step(S.lookX, dt);
      step(S.lookY, dt);
      step(S.squash, dt);
      step(S.hop, dt);
      step(S.tilt, dt);
      const tx = S.lookX.x * 6 * gain;
      const ty = (bob + S.hop.x + S.lookY.x * 3) * gain;
      const tilt = (S.lookX.x * 0.06 + S.tilt.x + S.lookX.v * 0.002) * gain;
      const sx = 1 + S.squash.x * 0.05 * gain;
      const sy = 1 - S.squash.x * 0.05 * gain;
      layers.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) rotate(${tilt.toFixed(4)}rad) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
      frame = requestAnimationFrame(loop);
    };
    const start = () => {
      if (!frame && visible()) {
        last = performance.now();
        frame = requestAnimationFrame(loop);
      }
    };
    const stop = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };
    const onVisibility = () => (visible() ? start() : stop());
    const onResize = () => measure();
    window.addEventListener('pointermove', onMove, { passive: true });
    root.addEventListener('pointerdown', onDown);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, {
      passive: true,
      capture: true,
    });
    start();
    return () => {
      stop();
      window.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerdown', onDown);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, { capture: true });
      layers.style.transform = '';
    };
  }, [live]);

  return (
    <span
      className={`mascot ${state} ${small ? 'small' : ''} ${live ? 'live' : ''}`}
      ref={rootRef}
    >
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
      {live ? (
        <span
          className="dot-layers"
          ref={layersRef}
          data-active={incoming ? 'b' : 'a'}
          aria-hidden={decorative}
        >
          <img
            className="dot-body"
            src={shown}
            alt={alt}
            width={512}
            height={512}
            draggable={false}
          />
          {incoming && (
            <img
              className="dot-body"
              src={incoming}
              alt=""
              width={512}
              height={512}
              draggable={false}
            />
          )}
        </span>
      ) : (
        <img
          className="dot-body"
          src={baseSrc}
          alt={alt}
          width={512}
          height={512}
          draggable={false}
        />
      )}
      {live && state === 'complete' && hasValidateOverlay(character) && (
        <span
          className="dot-validate"
          aria-hidden={decorative}
          aria-label={decorative ? undefined : 'Tâche terminée — valider'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              d="M5 13l4 4L19 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Valider
        </span>
      )}
    </span>
  );
}
