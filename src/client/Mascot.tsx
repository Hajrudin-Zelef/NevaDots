import { useEffect, useRef, useState } from 'react';
import {
  AVATAR_IDS,
  DEFAULT_AVATAR,
  avatarSrc,
  avatarStateCandidates,
  avatarStateFiles,
  hasValidateOverlay,
} from '../shared/avatars';

export const AVATARS = AVATAR_IDS;
export type Avatar = (typeof AVATARS)[number];

/** The avatar id to render: the Dot's own, or the default when unset/unknown. */
function avatarFile(avatar: string | null | undefined) {
  if (avatar && (AVATARS as readonly string[]).includes(avatar)) return avatar;
  return DEFAULT_AVATAR;
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
  name = 'Dot',
  decorative = false,
  avatar,
  animate,
}: {
  state?: string;
  small?: boolean;
  /** Accepted for call-site compatibility; no longer affects the avatar. */
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

  const character = avatarFile(avatar);
  const baseSrc = avatarSrc(character) ?? `/dots/${character}.png`;
  // Animated avatars ship their own motion; the synthetic CSS keyframe loops
  // (dot-idle/dot-think/...) are for still avatars only.
  const hasClips = avatarStateFiles(character).length > 0;

  // On each state entry pick one of the state's clip variants at random (some
  // avatars ship interchangeable variants), avoiding an immediate repeat so
  // successive requests visibly differ. Stable while the state is unchanged.
  const [variant, setVariant] = useState<string | null>(null);
  const lastVariant = useRef<string | null>(null);
  useEffect(() => {
    if (!live) return;
    const list = avatarStateCandidates(character, state);
    if (!list.length) {
      setVariant(null);
      return;
    }
    const pool =
      list.length > 1 && lastVariant.current
        ? list.filter((src) => src !== lastVariant.current)
        : list;
    const pick = pool[Math.floor(Math.random() * pool.length)] ?? list[0];
    lastVariant.current = pick;
    setVariant(pick);
  }, [character, state, live]);
  const wanted = (live && variant) || baseSrc;

  // Two persistent layers. A switch loads the incoming clip into the hidden
  // layer and lets it start animating there before dissolving to it, so a
  // change never shows a frozen first frame and the clip is never restarted
  // mid-fade (the previous one-shot swap did both).
  const [slots, setSlots] = useState<[string, string]>([baseSrc, baseSrc]);
  const [active, setActive] = useState<0 | 1>(0);
  const activeSrc = useRef(baseSrc);
  const activeRef = useRef<0 | 1>(0);
  const fadeTimer = useRef<number | undefined>(undefined);
  const fadeGen = useRef(0);
  const alt = decorative ? '' : `${name} is ${stateRef.current}`;

  // Reset the layers when the underlying avatar changes.
  useEffect(() => {
    activeSrc.current = baseSrc;
    activeRef.current = 0;
    setActive(0);
    setSlots([baseSrc, baseSrc]);
  }, [baseSrc]);

  // Dissolve to the wanted clip once it is decoded.
  useEffect(() => {
    const gen = ++fadeGen.current;
    window.clearTimeout(fadeTimer.current);
    if (!live || wanted === activeSrc.current) return;
    const next = wanted;
    const img = new Image();
    const commit = () => {
      if (gen !== fadeGen.current || next === activeSrc.current) return;
      const hidden: 0 | 1 = activeRef.current === 0 ? 1 : 0;
      setSlots((prev) => {
        const copy: [string, string] = [prev[0], prev[1]];
        copy[hidden] = next;
        return copy;
      });
      // Let the hidden clip run a beat, then dissolve to it.
      fadeTimer.current = window.setTimeout(() => {
        if (gen !== fadeGen.current) return;
        activeSrc.current = next;
        activeRef.current = hidden;
        setActive(hidden);
      }, 120);
    };
    img.onload = commit;
    img.onerror = commit;
    img.src = next;
    return () => {
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
      // Clipped avatars move through their own animation, so only the
      // interactive lean/hop applies; still avatars keep the synthetic bob.
      let bob = hasClips ? 0 : Math.sin(now / 1400) * 3;
      let tiltT = 0;
      if (!hasClips) {
        if (mode === 'listening') bob = Math.sin(now / 700) * 2.2;
        else if (
          mode === 'working' ||
          mode === 'thinking' ||
          mode === 'searching'
        )
          tiltT = 0.035 * Math.sin(now / 900);
        else if (mode === 'writing') bob = -Math.abs(Math.sin(now / 320)) * 3.5;
        else if (mode === 'complete') bob = Math.sin(now / 220) * 4;
      }
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
  }, [live, hasClips]);

  return (
    <span
      className={`mascot ${state} ${small ? 'small' : ''} ${live ? 'live' : ''} ${hasClips ? 'has-clips' : ''}`}
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
          data-active={active === 0 ? 'a' : 'b'}
          aria-hidden={decorative}
        >
          <img
            className="dot-body"
            src={slots[0]}
            alt={active === 0 ? alt : ''}
            width={512}
            height={512}
            draggable={false}
          />
          <img
            className="dot-body"
            src={slots[1]}
            alt={active === 1 ? alt : ''}
            width={512}
            height={512}
            draggable={false}
          />
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
