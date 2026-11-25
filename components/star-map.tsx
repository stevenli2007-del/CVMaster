"use client";

import { Html, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import * as THREE from "three";
import {
  MATERIAL_META,
  type ExperienceStar,
  type Position,
  type StarMaterial,
} from "@/lib/star-map";
import styles from "./star-map.module.css";

type StarMapProps = {
  stars: ExperienceStar[];
  selectedId: string | null;
  resetKey: number;
  reducedMotion: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
};

type BoundaryProps = { children: ReactNode; fallback: ReactNode };
type BoundaryState = { failed: boolean };

class WebGLBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function mulberry32(seed: number) {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function StarDust({ reducedMotion }: { reducedMotion: boolean }) {
  const farPoints = useRef<THREE.Points>(null);
  const mistPoints = useRef<THREE.Points>(null);
  const { far, mist } = useMemo(() => {
    const random = mulberry32(41024);
    const farPositions = new Float32Array(300 * 3);
    const farColors = new Float32Array(300 * 3);
    const mistPositions = new Float32Array(76 * 3);
    const color = new THREE.Color();

    for (let index = 0; index < 300; index += 1) {
      const stride = index * 3;
      farPositions[stride] = (random() - 0.5) * 29;
      farPositions[stride + 1] = (random() - 0.5) * 18;
      farPositions[stride + 2] = -4 - random() * 14;
      color.setHSL(0.61 + random() * 0.08, 0.28 + random() * 0.3, 0.58 + random() * 0.34);
      farColors[stride] = color.r;
      farColors[stride + 1] = color.g;
      farColors[stride + 2] = color.b;
    }

    for (let index = 0; index < 76; index += 1) {
      const stride = index * 3;
      const cluster = index % 2 === 0 ? -1 : 1;
      mistPositions[stride] = cluster * (4 + random() * 6) + (random() - 0.5) * 5;
      mistPositions[stride + 1] = (random() - 0.5) * 9;
      mistPositions[stride + 2] = -3 - random() * 9;
    }
    return { far: { positions: farPositions, colors: farColors }, mist: mistPositions };
  }, []);

  useFrame((state, delta) => {
    if (reducedMotion || document.hidden) return;
    if (farPoints.current) {
      farPoints.current.rotation.y += delta * 0.0018;
      farPoints.current.rotation.x = THREE.MathUtils.lerp(
        farPoints.current.rotation.x,
        state.pointer.y * 0.006,
        0.025,
      );
    }
    if (mistPoints.current) mistPoints.current.rotation.y -= delta * 0.001;
  });

  return (
    <>
      <points ref={farPoints} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[far.positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[far.colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.042}
          sizeAttenuation
          transparent
          opacity={0.72}
          vertexColors
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      <points ref={mistPoints} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[mist, 3]} />
        </bufferGeometry>
        <pointsMaterial
          color="#7777c8"
          size={0.16}
          sizeAttenuation
          transparent
          opacity={0.085}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </>
  );
}

function makeGlowTexture(hue: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context) {
    const color = new THREE.Color(`hsl(${hue}, 86%, 70%)`);
    const rgb = `${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}`;
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, `rgba(${rgb}, 0.7)`);
    gradient.addColorStop(0.18, `rgba(${rgb}, 0.32)`);
    gradient.addColorStop(0.5, `rgba(${rgb}, 0.08)`);
    gradient.addColorStop(1, `rgba(${rgb}, 0)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function MaterialFragment({
  material,
  index,
  starPosition,
  reducedMotion,
}: {
  material: StarMaterial;
  index: number;
  starPosition: Position;
  reducedMotion: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const age = useRef(0);
  const { camera, size } = useThree();
  const phase = index * 2.37 + 0.45;
  const radius = 1.02 + (index % 4) * 0.17;
  const tilt = -0.65 + (index % 5) * 0.31;
  const speed = 0.18 + (index % 3) * 0.035;
  const target = useMemo(() => new THREE.Vector3(), []);
  const tiltAxis = useMemo(() => new THREE.Vector3(0, 0, 1), []);
  const start = useMemo(() => {
    const source = new THREE.Vector3(
      (material.origin.x / size.width) * 2 - 1,
      -(material.origin.y / size.height) * 2 + 1,
      0.5,
    );
    source.unproject(camera);
    const direction = source.sub(camera.position).normalize();
    const distance = (starPosition[2] - camera.position.z) / direction.z;
    return camera.position.clone().add(direction.multiplyScalar(distance)).sub(new THREE.Vector3(...starPosition));
  }, [camera, material, size.height, size.width, starPosition]);

  useFrame((_, delta) => {
    if (!group.current || document.hidden) return;
    if (!reducedMotion) age.current += delta;
    const angle = phase + (reducedMotion ? 0 : age.current * speed);
    target.set(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.48, Math.sin(angle) * radius * 0.72);
    target.applyAxisAngle(tiltAxis, tilt);

    if (!reducedMotion && age.current < 0.78) {
      const progress = Math.min(1, age.current / 0.78);
      const eased = 1 - Math.pow(1 - progress, 3);
      group.current.position.lerpVectors(start, target, eased);
      group.current.scale.setScalar(0.45 + eased * 0.55);
    } else {
      group.current.position.copy(target);
      group.current.scale.setScalar(1);
    }
    group.current.rotation.y = reducedMotion ? phase : age.current * 0.7 + phase;
    group.current.rotation.z = reducedMotion ? 0 : age.current * 0.25;
  });

  return (
    <group ref={group} position={start}>
      <mesh>
        <octahedronGeometry args={[0.075, 0]} />
        <meshBasicMaterial color={MATERIAL_META[material.kind].color} toneMapped={false} />
      </mesh>
      <mesh scale={1.75}>
        <octahedronGeometry args={[0.075, 0]} />
        <meshBasicMaterial
          color={MATERIAL_META[material.kind].color}
          transparent
          opacity={0.12}
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
}

function Planet({
  star,
  selected,
  dimmed,
  reducedMotion,
  onSelect,
}: {
  star: ExperienceStar;
  selected: boolean;
  dimmed: boolean;
  reducedMotion: boolean;
  onSelect: () => void;
}) {
  const group = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const glowTexture = useMemo(() => makeGlowTexture(star.hue), [star.hue]);
  const radius = 0.61 + Math.min(star.materials.length, 8) * 0.025;
  const latestMaterial = star.materials.at(-1);

  useEffect(() => () => glowTexture.dispose(), [glowTexture]);

  useFrame((_, delta) => {
    if (!group.current || document.hidden) return;
    const creationProgress = reducedMotion ? 1 : Math.min(1, (performance.now() - star.createdAt) / 1050);
    const creationScale = 1 - Math.pow(1 - creationProgress, 3);
    const pulseAge = latestMaterial ? (performance.now() - latestMaterial.createdAt) / 1000 : 2;
    const pulse = !reducedMotion && pulseAge < 0.75
      ? Math.sin((pulseAge / 0.75) * Math.PI) * 0.085
      : 0;
    group.current.scale.setScalar(Math.max(0.001, creationScale + pulse));
    if (ring.current && !reducedMotion) ring.current.rotation.z += delta * 0.035;
  });

  function setPointerCursor(event: ThreeEvent<PointerEvent>, active: boolean) {
    event.stopPropagation();
    document.body.style.cursor = active ? "pointer" : "default";
  }

  return (
    <group position={star.position}>
      <group
        ref={group}
        onClick={(event) => { event.stopPropagation(); onSelect(); }}
        onPointerOver={(event) => setPointerCursor(event, true)}
        onPointerOut={(event) => setPointerCursor(event, false)}
      >
        <sprite scale={[radius * 5.3, radius * 5.3, 1]}>
          <spriteMaterial
            map={glowTexture}
            transparent
            opacity={dimmed ? 0.1 : selected ? 0.58 : 0.34}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>
        <mesh>
          <sphereGeometry args={[radius, 48, 48]} />
          <meshStandardMaterial
            color={`hsl(${star.hue}, 56%, ${selected ? 57 : 46}%)`}
            emissive={`hsl(${star.hue}, 70%, 31%)`}
            emissiveIntensity={selected ? 0.72 : 0.38}
            roughness={0.72}
            metalness={0.06}
            transparent
            opacity={dimmed ? 0.3 : 1}
          />
        </mesh>
        <mesh scale={1.09}>
          <sphereGeometry args={[radius, 32, 32]} />
          <meshBasicMaterial
            color={`hsl(${star.hue}, 90%, 72%)`}
            transparent
            opacity={dimmed ? 0.025 : selected ? 0.14 : 0.075}
            side={THREE.BackSide}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
        <mesh ref={ring} rotation={[1.04, 0.24, -0.35]}>
          <ringGeometry args={[radius * 1.38, radius * 1.405, 96]} />
          <meshBasicMaterial
            color={selected ? "#c8c4ff" : `hsl(${star.hue}, 70%, 72%)`}
            transparent
            opacity={dimmed ? 0.05 : selected ? 0.55 : 0.2}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
        {star.materials.map((material, index) => (
          <MaterialFragment
            key={material.id}
            material={material}
            index={index}
            starPosition={star.position}
            reducedMotion={reducedMotion}
          />
        ))}
      </group>
      <Html position={[0, -radius - 0.43, 0]} center zIndexRange={[18, 2]}>
        <button
          type="button"
          data-star-nav="true"
          data-star-id={star.id}
          className={`${styles.starLabel} ${selected ? styles.starLabelSelected : ""} ${dimmed ? styles.starLabelDimmed : ""}`}
          onClick={onSelect}
          onKeyDown={(event) => navigateStarLabels(event, star.id)}
          aria-pressed={selected}
          aria-label={`${star.name || "Untitled star"}, ${star.materials.length} saved ${star.materials.length === 1 ? "fragment" : "fragments"}. Open star.`}
        >
          <span>{star.name || "Untitled star"}</span>
          <small>{star.materials.length} {star.materials.length === 1 ? "fragment" : "fragments"}</small>
        </button>
      </Html>
    </group>
  );
}

type ControlsHandle = ComponentRef<typeof OrbitControls>;
type CameraTransition = {
  progress: number;
  fromCamera: THREE.Vector3;
  toCamera: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
};

function SceneControls({
  focusPosition,
  resetKey,
  reducedMotion,
}: {
  focusPosition: Position | null;
  resetKey: number;
  reducedMotion: boolean;
}) {
  const controls = useRef<ControlsHandle>(null);
  const transition = useRef<CameraTransition | null>(null);
  const { camera } = useThree();

  useEffect(() => {
    if (!controls.current) return;
    const toTarget = focusPosition
      ? new THREE.Vector3(...focusPosition).add(new THREE.Vector3(2.25, 0, 0))
      : new THREE.Vector3(0, 0, 0);
    const toCamera = focusPosition
      ? new THREE.Vector3(...focusPosition).add(new THREE.Vector3(2.25, 0.45, 6.2))
      : new THREE.Vector3(0, 0.5, 12.5);

    if (reducedMotion) {
      camera.position.copy(toCamera);
      controls.current.target.copy(toTarget);
      controls.current.update();
      transition.current = null;
      return;
    }

    transition.current = {
      progress: 0,
      fromCamera: camera.position.clone(),
      toCamera,
      fromTarget: controls.current.target.clone(),
      toTarget,
    };
  }, [camera, focusPosition, reducedMotion, resetKey]);

  useFrame((_, delta) => {
    const current = transition.current;
    if (!current || !controls.current) return;
    current.progress = Math.min(1, current.progress + delta / 0.72);
    const eased = (1 - Math.cos(current.progress * Math.PI)) / 2;
    camera.position.lerpVectors(current.fromCamera, current.toCamera, eased);
    controls.current.target.lerpVectors(current.fromTarget, current.toTarget, eased);
    controls.current.update();
    if (current.progress === 1) transition.current = null;
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enablePan={false}
      enableDamping={!reducedMotion}
      dampingFactor={0.075}
      rotateSpeed={0.48}
      zoomSpeed={0.65}
      minDistance={4.2}
      maxDistance={21}
      minPolarAngle={0.28}
      maxPolarAngle={Math.PI - 0.28}
      onStart={() => { transition.current = null; }}
    />
  );
}

function navigateStarLabels(event: KeyboardEvent<HTMLButtonElement>, id: string) {
  const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  const labels = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-star-nav='true']"));
  const index = labels.findIndex((label) => label.dataset.starId === id);
  if (index < 0 || labels.length === 0) return;
  let nextIndex = index;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % labels.length;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + labels.length) % labels.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = labels.length - 1;
  labels[nextIndex]?.focus();
}

function FallbackMap({ stars, selectedId, onSelect }: Pick<StarMapProps, "stars" | "selectedId" | "onSelect">) {
  return (
    <div className={styles.fallbackMap} aria-label="Star list, static mode">
      <p className={styles.fallbackNotice}>Static star map · WebGL is unavailable</p>
      {stars.map((star) => (
        <button
          key={star.id}
          type="button"
          data-star-nav="true"
          data-star-id={star.id}
          className={`${styles.fallbackStar} ${selectedId === star.id ? styles.fallbackStarSelected : ""}`}
          style={{
            "--star-x": `${star.position[0] * 42}px`,
            "--star-y": `${star.position[1] * -38}px`,
            "--star-hue": star.hue,
          } as CSSProperties}
          onClick={() => onSelect(star.id)}
          onKeyDown={(event) => navigateStarLabels(event, star.id)}
          aria-pressed={selectedId === star.id}
        >
          <i aria-hidden="true" />
          <span>{star.name || "Untitled star"}</span>
          <small>{star.materials.length} fragments</small>
        </button>
      ))}
    </div>
  );
}

function detectWebGL() {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") || canvas.getContext("webgl");
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return Boolean(context);
  } catch {
    return false;
  }
}

export default function StarMap(props: StarMapProps) {
  const [webGLAvailable] = useState(detectWebGL);
  const { stars, selectedId, resetKey, reducedMotion, onSelect, onClose } = props;
  const selectedStar = stars.find((star) => star.id === selectedId);
  const focusPosition = selectedStar?.position ?? null;
  const fallback = <FallbackMap stars={stars} selectedId={selectedId} onSelect={onSelect} />;

  if (!webGLAvailable) return fallback;

  return (
    <div className={styles.scene} role="group" aria-label="Interactive 3D experience star map">
      <WebGLBoundary fallback={fallback}>
        <Canvas
          camera={{ position: [0, 0.5, 12.5], fov: 43, near: 0.1, far: 100 }}
          dpr={[1, 1.75]}
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
          onCreated={({ gl }) => gl.setClearColor("#04050D", 0)}
          onPointerMissed={(event) => {
            if (event.type === "click" && selectedId) onClose();
          }}
        >
          <ambientLight intensity={0.52} color="#b7c2ff" />
          <directionalLight position={[-4, 6, 8]} intensity={2.1} color="#e4e5ff" />
          <pointLight position={[5, -3, 4]} intensity={8} color="#5365d9" distance={18} />
          <StarDust reducedMotion={reducedMotion} />
          {stars.map((star) => (
            <Planet
              key={star.id}
              star={star}
              selected={star.id === selectedId}
              dimmed={Boolean(selectedId && star.id !== selectedId)}
              reducedMotion={reducedMotion}
              onSelect={() => onSelect(star.id)}
            />
          ))}
          <SceneControls focusPosition={focusPosition} resetKey={resetKey} reducedMotion={reducedMotion} />
        </Canvas>
      </WebGLBoundary>
    </div>
  );
}
