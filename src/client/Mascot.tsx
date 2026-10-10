const characters = ['blue', 'pink', 'green'] as const;

/** Stable identity keeps each specialist recognizable across views and reloads. */
function characterFor(identity?: string) {
  if (!identity) return characters[0];
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return characters[hash % characters.length];
}

export function Mascot({
  state = 'idle',
  small = false,
  identity,
  name = 'Dot',
  decorative = false,
}: {
  state?: string;
  small?: boolean;
  identity?: string;
  name?: string;
  decorative?: boolean;
}) {
  return (
    <span className={`mascot ${state} ${small ? 'small' : ''}`}>
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
    </span>
  );
}
