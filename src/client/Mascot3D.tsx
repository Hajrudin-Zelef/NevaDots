import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Three.js Dot avatar. The GLB is the static base model; every motion is driven
 * here in TypeScript so Mascot states map to predictable animations.
 */
const MODEL_URL = '/models/dot.glb';

let cachedModel: Promise<THREE.Group> | null = null;
function loadModel(): Promise<THREE.Group> {
  if (!cachedModel) {
    cachedModel = new GLTFLoader()
      .loadAsync(MODEL_URL)
      .then((gltf) => gltf.scene);
  }
  return cachedModel;
}

const TINTS: Record<string, number> = {
  blue: 0x2f9bff,
  pink: 0xff6ec7,
  green: 0x35d07f,
};

function characterFor(identity?: string): keyof typeof TINTS {
  if (!identity) return 'blue';
  let hash = 0;
  for (const character of identity) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return (['blue', 'pink', 'green'] as const)[hash % 3];
}

/** Map any incoming state onto the animations we know how to play. */
function normalize(state: string): string {
  switch (state) {
    case 'idle':
    case 'thinking':
    case 'analyzing':
    case 'searching':
    case 'writing':
    case 'listening':
    case 'complete':
    case 'error':
    case 'paused':
      return state;
    case 'working':
      return 'thinking';
    default:
      return 'idle';
  }
}

export function Mascot3D({
  state,
  identity,
  onUnsupported,
}: {
  state: string;
  identity?: string;
  onUnsupported?: () => void;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const stateRef = useRef(state);
  const startRef = useRef(0);
  const reduceRef = useRef(false);
  const onUnsupportedRef = useRef(onUnsupported);
  onUnsupportedRef.current = onUnsupported;

  useEffect(() => {
    stateRef.current = state;
    startRef.current = performance.now();
  }, [state]);

  useEffect(() => {
    const mount = host.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: 'low-power',
      });
    } catch {
      onUnsupportedRef.current?.();
      return;
    }

    reduceRef.current = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    const canvas = renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    mount.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
    camera.position.set(0, 0.1, -5);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x223355, 1.35));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(3, 5, 4);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x8fd0ff, 1.15);
    rimLight.position.set(-4, 2, -3);
    scene.add(rimLight);

    const pivot = new THREE.Group();
    scene.add(pivot);

    // Fast orbiting particles, shown only while "searching".
    const particles = 46;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particles * 3);
    const seeds = new Float32Array(particles);
    for (let i = 0; i < particles; i += 1) seeds[i] = Math.random();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3),
    );
    const particleMaterial = new THREE.PointsMaterial({
      color: 0x8fd8ff,
      size: 0.1,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geometry, particleMaterial);
    pivot.add(points);

    let disposed = false;
    let visible = true;
    let radius = 1;
    let model: THREE.Object3D | null = null;

    loadModel()
      .then((source) => {
        if (disposed) return;
        const clone = source.clone(true);
        const tint = TINTS[characterFor(identity)] ?? TINTS.blue;
        clone.traverse((object) => {
          const mesh = object as THREE.Mesh;
          const material = mesh.material as
            | THREE.MeshStandardMaterial
            | THREE.MeshStandardMaterial[]
            | undefined;
          if (!material) return;
          const apply = (entry: THREE.MeshStandardMaterial) => {
            const next = entry.clone();
            if (next.name === 'Shell_Blue') next.color.setHex(tint);
            return next;
          };
          mesh.material = Array.isArray(material)
            ? material.map(apply)
            : apply(material);
        });
        const box = new THREE.Box3().setFromObject(clone);
        const center = box.getCenter(new THREE.Vector3());
        clone.position.sub(center);
        const size = box.getSize(new THREE.Vector3());
        radius = Math.max(size.x, size.y, size.z);
        pivot.add(clone);
        model = clone;
        const distance = radius * 1.55;
        camera.position.set(distance * 0.32, distance * 0.16, -distance * 0.95);
        camera.lookAt(0, 0, 0);
      })
      .catch(() => onUnsupportedRef.current?.());

    const resize = () => {
      const width = mount.clientWidth || 1;
      const height = mount.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);

    const visibilityObserver = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
    });
    visibilityObserver.observe(mount);

    const startTime = performance.now();
    let frame = 0;
    const animate = () => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      if (!visible) return;

      const time = ((performance.now() - startTime) / 1000) * 1.6;
      const current = normalize(stateRef.current);
      const since = (performance.now() - startRef.current) / 1000;
      const amp = reduceRef.current ? 0.12 : 1;

      pivot.position.set(0, 0, 0);
      pivot.rotation.set(0, 0, 0);
      pivot.scale.set(1, 1, 1);
      particleMaterial.opacity += (0 - particleMaterial.opacity) * 0.12;

      const swirl = (speed: number) => {
        particleMaterial.opacity += (0.9 - particleMaterial.opacity) * 0.12;
        const buffer = geometry.attributes.position.array as Float32Array;
        for (let i = 0; i < particles; i += 1) {
          const angle = seeds[i] * Math.PI * 2 + time * speed;
          const orbit = radius * 0.95 + Math.sin(time * 3 + i) * 0.12;
          buffer[i * 3] = Math.cos(angle) * orbit;
          buffer[i * 3 + 1] = Math.sin(seeds[i] * 12 + time * 2) * 0.55;
          buffer[i * 3 + 2] = Math.sin(angle) * orbit;
        }
        geometry.attributes.position.needsUpdate = true;
      };

      switch (current) {
        case 'idle':
          pivot.position.y = Math.sin(time * 1.4) * 0.09 * amp;
          pivot.rotation.y = Math.sin(time * 0.6) * 0.24 * amp;
          break;
        case 'thinking':
          pivot.rotation.y = time * 0.9 * amp;
          pivot.rotation.z = Math.sin(time * 2) * 0.05 * amp;
          pivot.scale.setScalar(1 + Math.sin(time * 3) * 0.03 * amp);
          break;
        case 'analyzing':
          pivot.rotation.y = time * 0.35 * amp;
          pivot.position.y = Math.sin(time * 0.8) * 0.03 * amp;
          break;
        case 'searching':
          pivot.rotation.y = time * 1.5 * amp;
          swirl(2.4);
          break;
        case 'writing':
          pivot.position.y = Math.abs(Math.sin(time * 7)) * 0.05 * amp;
          pivot.rotation.z = Math.sin(time * 9) * 0.05 * amp;
          pivot.rotation.y = Math.sin(time * 3) * 0.1 * amp;
          break;
        case 'complete': {
          const progress = Math.min(since / 1.1, 1);
          pivot.position.y =
            Math.abs(Math.sin(progress * Math.PI * 2)) *
            (1 - progress) *
            0.35 *
            amp;
          pivot.scale.setScalar(1 + (1 - progress) * 0.05 * amp);
          break;
        }
        case 'error': {
          const progress = Math.min(since / 1.4, 1);
          const shake = Math.sin(since * 28) * 0.12 * (1 - progress) * amp;
          pivot.position.x = shake;
          pivot.rotation.z = shake * 0.7;
          break;
        }
        case 'listening':
          pivot.scale.setScalar(1 + Math.sin(time * 4) * 0.05 * amp);
          pivot.position.y = Math.sin(time * 2) * 0.03 * amp;
          break;
        case 'paused':
        default:
          break;
      }

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      if (model) {
        model.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          const material = mesh.material as
            | THREE.Material
            | THREE.Material[]
            | undefined;
          if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
          else material?.dispose();
        });
      }
      geometry.dispose();
      particleMaterial.dispose();
      renderer.dispose();
      canvas.remove();
    };
  }, [identity]);

  return <span ref={host} className="mascot-canvas-host" aria-hidden="true" />;
}
