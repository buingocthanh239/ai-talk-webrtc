/**
 * Avatar 3D — nhan bang trong so viseme, keo morph target tren mesh.
 *
 * Chi lam dung mot viec: dung hinh va ve. Timeline do `viseme-player.ts` tinh,
 * du lieu do Polly sinh. Neu mom nhep sai thi lan luot loai tru duoc ba tang.
 *
 * Model phai co morph target bo Oculus. Voi Ready Player Me nghia la khi tai
 * .glb phai them `?morphTargets=Oculus Visemes` — thieu tham so do thi model
 * van hien ra binh thuong nhung khong co khau hinh nao, va khong bao loi gi.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { VISEMES, morphName, type Viseme } from '../../shared/viseme.ts';
import type { VisemeWeights } from './viseme-player.ts';

/** Mesh co morph target, kem chi so cua tung viseme tren mesh do. */
interface VisemeTarget {
  mesh: THREE.Mesh;
  /** viseme -> chi so trong morphTargetInfluences. Thieu viseme nao thi bo. */
  slots: Partial<Record<Viseme, number>>;
}

export class Avatar {
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera: THREE.PerspectiveCamera;
  readonly #canvas: HTMLCanvasElement;

  #targets: VisemeTarget[] = [];
  #raf: number | null = null;
  #resizeObserver: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    // Chan o 2: tren man hinh 3x thi khung nay ton gap 9 lan pixel ma gan nhu
    // khong dep them, trong khi day la trang co the mo lau tren may yeu.
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.#camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);

    // Anh sang ba diem rut gon. Khau hinh doc duoc hay khong phu thuoc vao do
    // dai bong quanh moi, nen den chinh dat chech chu khong dat thang.
    this.#scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(0.6, 1.4, 1.2);
    this.#scene.add(key);
    const fill = new THREE.DirectionalLight(0xdbeafe, 0.9);
    fill.position.set(-1, 0.6, 0.8);
    this.#scene.add(fill);

    this.#observeSize();
  }

  /** Tai model. Nem neu tai hong — goi quyet dinh co roi ve thanh do hay khong. */
  async load(url: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    const root = gltf.scene;
    this.#scene.add(root);
    this.#collectTargets(root);
    this.#frameHead(root);
  }

  /** So mesh tim thay khau hinh tren do. 0 = model khong co morph target Oculus. */
  get targetCount(): number {
    return this.#targets.length;
  }

  #collectTargets(root: THREE.Object3D): void {
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      const dict = mesh.morphTargetDictionary;
      if (!dict || !mesh.morphTargetInfluences) return;

      const slots: Partial<Record<Viseme, number>> = {};
      for (const v of VISEMES) {
        const index = dict[morphName(v)];
        if (index !== undefined) slots[v] = index;
      }
      // Rang va luoi nam o mesh rieng voi dau; ca hai deu phai duoc keo, nen
      // gom TAT CA mesh co viseme chu khong dung lai o mesh dau tien.
      if (Object.keys(slots).length) this.#targets.push({ mesh, slots });
    });
  }

  /**
   * Dua khung hinh ve quanh dau.
   *
   * Uu tien xuong 'Head': avatar Ready Player Me co the la ban than hoac toan
   * than, chieu cao khac han nhau, nen lay chieu cao model ma suy ra la doan.
   * Khong tim thay xuong thi roi ve boundingBox — van hon la mot con so chet.
   */
  #frameHead(root: THREE.Object3D): void {
    const head = root.getObjectByName('Head');
    const focus = new THREE.Vector3();

    if (head) {
      head.getWorldPosition(focus);
      focus.y += 0.05; // xuong Head nam o chan so, nang len tam moi/mui
    } else {
      const box = new THREE.Box3().setFromObject(root);
      box.getCenter(focus);
      focus.y = box.max.y - (box.max.y - box.min.y) * 0.08;
    }

    this.#camera.position.set(focus.x, focus.y, focus.z + 0.42);
    this.#camera.lookAt(focus);
  }

  /** Ap trong so len morph target. Goi moi frame render tu VisemePlayer. */
  apply(weights: VisemeWeights): void {
    for (const { mesh, slots } of this.#targets) {
      const influences = mesh.morphTargetInfluences;
      if (!influences) continue;
      for (const v of VISEMES) {
        const slot = slots[v];
        if (slot !== undefined) influences[slot] = weights[v];
      }
    }
  }

  start(): void {
    if (this.#raf !== null) return;
    const tick = (): void => {
      this.#renderer.render(this.#scene, this.#camera);
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.#raf !== null) cancelAnimationFrame(this.#raf);
    this.#raf = null;
  }

  dispose(): void {
    this.stop();
    this.#resizeObserver?.disconnect();
    this.#renderer.dispose();
  }

  /**
   * Canvas an theo CSS nen kich thuoc khong biet truoc. ResizeObserver thay vi
   * window.resize: panel nay nam trong layout co the co gian ma cua so khong
   * doi kich thuoc.
   */
  #observeSize(): void {
    const resize = (): void => {
      const { clientWidth: w, clientHeight: h } = this.#canvas;
      if (!w || !h) return;
      this.#renderer.setSize(w, h, false);
      this.#camera.aspect = w / h;
      this.#camera.updateProjectionMatrix();
    };
    this.#resizeObserver = new ResizeObserver(resize);
    this.#resizeObserver.observe(this.#canvas);
    resize();
  }
}
