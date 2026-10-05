import { useEffect, useRef, useState, type ReactNode } from "react";
import type * as ThreeNS from "three";
import { MARK_COPPER_D, MARK_NAVY_D, MARK_VIEWBOX } from "../brand/markPaths";

/** Written by the orbit stage every frame and read by the backdrop scene (no React re-renders involved). */
export class SceneDriver {
  progress = 0;
  velocity = 0;
  setProgress(p: number) {
    this.progress = p;
  }
  setVelocity(v: number) {
    this.velocity = v;
  }
}

export type SceneVariant = "splash" | "hero" | "backdrop";

type Modules = {
  T: typeof ThreeNS;
  SVGLoader: typeof import("three/examples/jsm/loaders/SVGLoader.js").SVGLoader;
  RoomEnvironment: typeof import("three/examples/jsm/environments/RoomEnvironment.js").RoomEnvironment;
};

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

function sprite(T: typeof ThreeNS) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new T.CanvasTexture(c);
}

function build(
  { T, SVGLoader, RoomEnvironment }: Modules,
  host: HTMLElement,
  variant: SceneVariant,
  driver: SceneDriver | undefined,
  onReady: (() => void) | undefined,
) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, variant === "backdrop" ? 1.5 : 2));
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.outputColorSpace = T.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.style.cssText = "display:block;width:100%;height:100%";
  host.appendChild(canvas);

  const scene = new T.Scene();
  const pmrem = new T.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTarget = pmrem.fromScene(room, 0.04);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = variant === "backdrop" ? 0.9 : 0.7;

  const camera = new T.PerspectiveCamera(32, 1, 1, 6000);
  const baseDistance = variant === "backdrop" ? 1500 : variant === "hero" ? 800 : 860;

  // ---- logo mark, extruded from the traced paths ----
  const { width: w, height: h } = MARK_VIEWBOX;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><path d="${MARK_NAVY_D}"/><path d="${MARK_COPPER_D}"/></svg>`;
  const parsed = new SVGLoader().parse(svg);
  const logo = new T.Group();
  const flip = new T.Group();
  flip.scale.set(1, -1, 1);
  logo.add(flip);
  const ghost = variant === "backdrop";
  const materials: ThreeNS.Material[] = ghost
    ? [
        new T.MeshBasicMaterial({ color: 0x7ea6f2, transparent: true, opacity: 0.07, depthWrite: false }),
        new T.MeshBasicMaterial({ color: 0xf0b88c, transparent: true, opacity: 0.1, depthWrite: false }),
      ]
    : [
    new T.MeshPhysicalMaterial({
      color: 0x1b4fb3,
      metalness: 0.72,
      roughness: 0.34,
      clearcoat: 1,
      clearcoatRoughness: 0.2,
    }),
    new T.MeshPhysicalMaterial({
      color: 0xcf8d5c,
      metalness: 0.92,
      roughness: 0.3,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25,
    }),
  ];
  const geometries: ThreeNS.BufferGeometry[] = [];
  parsed.paths.forEach((path, i) => {
    const shapes = path.toShapes();
    const geo = new T.ExtrudeGeometry(shapes, {
      depth: 30,
      bevelEnabled: true,
      bevelThickness: 4,
      bevelSize: 2.5,
      bevelSegments: 4,
      curveSegments: 14,
    });
    geo.translate(-w / 2, -h / 2, -15);
    geometries.push(geo);
    flip.add(new T.Mesh(geo, materials[Math.min(i, 1)]));
  });
  scene.add(logo);

  // ---- orbit rings (splash + hero) ----
  const rings: ThreeNS.Mesh[] = [];
  const ringMat = new T.MeshBasicMaterial({ color: 0xe0a070, transparent: true, opacity: 0.5 });
  const ringMat2 = new T.MeshBasicMaterial({ color: 0x6c9cf0, transparent: true, opacity: 0.4 });
  if (variant !== "backdrop") {
    const r1 = new T.Mesh(new T.TorusGeometry(205, 0.9, 8, 200), ringMat);
    const r2 = new T.Mesh(new T.TorusGeometry(240, 0.7, 8, 200), ringMat2);
    r1.rotation.x = Math.PI / 2.4;
    r2.rotation.x = Math.PI / 2.1;
    r2.rotation.y = 0.5;
    rings.push(r1, r2);
    rings.forEach((r) => scene.add(r));
  }

  // ---- particles ----
  const COUNT = variant === "splash" ? 1500 : variant === "hero" ? 520 : 1700;
  const pos = new Float32Array(COUNT * 3);
  const col = new Float32Array(COUNT * 3);
  const copper = new T.Color(0xf0b88c);
  const blue = new T.Color(0x7ea6f2);
  for (let i = 0; i < COUNT; i++) {
    const r = (variant === "backdrop" ? 500 : 230) + Math.random() * (variant === "backdrop" ? 1500 : 560);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * (variant === "backdrop" ? 0.7 : 1);
    pos[i * 3 + 2] = r * Math.cos(phi);
    const c = Math.random() < 0.55 ? copper : blue;
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  const pgeo = new T.BufferGeometry();
  pgeo.setAttribute("position", new T.BufferAttribute(pos, 3));
  pgeo.setAttribute("color", new T.BufferAttribute(col, 3));
  const tex = sprite(T);
  const pmat = new T.PointsMaterial({
    size: variant === "backdrop" ? 9 : 7,
    map: tex,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: T.AdditiveBlending,
    sizeAttenuation: true,
  });
  const points = new T.Points(pgeo, pmat);
  scene.add(points);

  // ---- lights ----
  scene.add(new T.AmbientLight(0xffffff, 0.35));
  const key = new T.DirectionalLight(0xffe2c4, 2.4);
  key.position.set(300, 400, 500);
  scene.add(key);
  const rim = new T.PointLight(0x5b8cf0, 6e5, 2400, 1.6);
  rim.position.set(-380, -120, 260);
  scene.add(rim);

  if (variant === "backdrop") {
    logo.scale.setScalar(5.6);
    logo.position.set(0, 60, -1000);
  }

  // ---- sizing ----
  let width = 1;
  let height = 1;
  const resize = () => {
    const r = host.getBoundingClientRect();
    width = Math.max(1, Math.round(r.width));
    height = Math.max(1, Math.round(r.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // Keep the mark fully in frame on tall / narrow containers.
    const fit = Math.min(1, camera.aspect * (variant === "hero" ? 1.1 : 0.95));
    camera.position.set(0, 0, baseDistance / fit);
  };
  resize();
  const ro = new ResizeObserver(() => {
    resize();
    if (reduce) renderFrame(performance.now());
  });
  ro.observe(host);

  // ---- pointer parallax ----
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const onPointer = (e: PointerEvent) => {
    const r = variant === "splash" || variant === "backdrop" ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : host.getBoundingClientRect();
    pointer.tx = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.ty = ((e.clientY - r.top) / r.height) * 2 - 1;
  };
  window.addEventListener("pointermove", onPointer, { passive: true });

  // ---- frame ----
  const t0 = performance.now();
  let last = t0;
  let raf = 0;
  let visible = true;
  let announced = false;
  const introMs = variant === "splash" ? 2200 : variant === "hero" ? 1400 : 0;

  function renderFrame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = (now - t0) / 1000;
    const introT = reduce || introMs === 0 ? 1 : Math.min(1, (now - t0) / introMs);
    const e = easeOutCubic(introT);
    const b = easeOutBack(introT);

    pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 4);
    pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 4);

    if (variant === "backdrop") {
      const p = driver?.progress ?? 0;
      const v = driver?.velocity ?? 0;
      logo.rotation.y = p * 0.55 + Math.sin(t * 0.25) * 0.1 + pointer.x * 0.15;
      logo.rotation.x = pointer.y * 0.1;
      points.rotation.y = p * 0.3 + t * 0.012;
      points.rotation.x = pointer.y * 0.04;
      camera.position.x = pointer.x * 40 - v * 90;
      camera.position.y = -pointer.y * 24;
      camera.lookAt(0, 0, -300);
    } else {
      const sway = reduce ? 0 : Math.sin(t * 0.7) * 0.3;
      logo.rotation.y = (1 - e) * -Math.PI * 3 + sway + pointer.x * 0.5;
      logo.rotation.x = pointer.y * 0.28 + (reduce ? 0 : Math.sin(t * 0.5) * 0.05);
      logo.scale.setScalar(Math.max(0.0001, 0.25 + 0.75 * b));
      logo.position.y = reduce ? 0 : Math.sin(t * 1.1) * 4;
      rings.forEach((r, i) => {
        r.scale.setScalar(Math.max(0.0001, e));
        r.rotation.z = t * (i === 0 ? 0.35 : -0.25);
        r.rotation.y = (i === 1 ? 0.5 : 0) + Math.sin(t * 0.4 + i) * 0.15;
      });
      points.scale.setScalar(variant === "splash" ? 0.05 + 0.95 * e : 1);
      points.rotation.y = t * 0.06;
      points.rotation.x = Math.sin(t * 0.1) * 0.12;
      camera.position.x = pointer.x * 24;
      camera.position.y = -pointer.y * 16;
      camera.lookAt(0, 0, 0);
    }
    rim.position.x = -380 + pointer.x * 160;
    renderer.render(scene, camera);
    if (!announced) {
      announced = true;
      onReady?.();
    }
  }

  let skip = false;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (variant === "backdrop") {
      // Ambient scene: half the frame rate is plenty and leaves the GPU to the panels on top of it.
      skip = !skip;
      if (skip) return;
    }
    if (visible && !document.hidden) renderFrame(now);
  };
  if (reduce) renderFrame(performance.now() + 10_000);
  else raf = requestAnimationFrame(loop);

  const io = new IntersectionObserver((entries) => {
    visible = entries.some((en) => en.isIntersecting);
  });
  io.observe(host);

  return () => {
    cancelAnimationFrame(raf);
    io.disconnect();
    ro.disconnect();
    window.removeEventListener("pointermove", onPointer);
    geometries.forEach((g) => g.dispose());
    rings.forEach((r) => r.geometry.dispose());
    [...materials, ringMat, ringMat2, pmat].forEach((m) => m.dispose());
    pgeo.dispose();
    tex.dispose();
    envTarget.dispose();
    room.dispose();
    pmrem.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
}

/**
 * The INT Comply mark as a real 3D object (metallic navy + copper, extruded from the logo paths) in a
 * field of drifting particles. `splash` spins in big, `hero` is the smaller login-card version, `backdrop`
 * is a dim wide scene that reacts to a `driver` (the orbit stage's scroll progress and velocity).
 * Falls back to `fallback` when WebGL is unavailable.
 */
export function LogoScene({
  variant,
  className = "",
  fallback = null,
  driver,
  onReady,
}: {
  variant: SceneVariant;
  className?: string;
  fallback?: ReactNode;
  driver?: SceneDriver;
  /** Called once, after the first frame is drawn (or straight away if WebGL is unavailable). */
  onReady?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const readyRef = useRef(onReady);
  useEffect(() => {
    readyRef.current = onReady;
  });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      try {
        const [T, loaders, env] = await Promise.all([
          import("three"),
          import("three/examples/jsm/loaders/SVGLoader.js"),
          import("three/examples/jsm/environments/RoomEnvironment.js"),
        ]);
        if (disposed) return;
        cleanup = build({ T, SVGLoader: loaders.SVGLoader, RoomEnvironment: env.RoomEnvironment }, el, variant, driver, () => readyRef.current?.());
      } catch {
        if (!disposed) {
          setFailed(true);
          readyRef.current?.();
        }
      }
    })();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [variant, driver]);

  return (
    <div ref={host} className={className} aria-hidden>
      {failed ? fallback : null}
    </div>
  );
}
