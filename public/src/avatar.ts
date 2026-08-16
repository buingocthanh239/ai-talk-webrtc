/**
 * Avatar Spine 2D — nhan mot viseme ID, phat animation khau hinh tuong ung.
 *
 * Chi lam dung mot viec: dung hinh va ve. Timeline do `viseme-player.ts` tinh,
 * du lieu do Polly sinh. Neu mom nhep sai thi lan luot loai tru duoc ba tang.
 *
 * BA DIEU DE VAP:
 *
 * 1. **Hai track.** `Idle*` va `Blink` chay o track 0, viseme o track 1. Bat
 *    buoc phai tach, vi Idle CUNG animate Mouth1..Mouth8 — nhet chung mot track
 *    la mieng vua nhep vua bi Idle keo.
 *
 * 2. **Cac animation viseme khong key cung mot bo bone.** Vi du Leo `viseme_0`
 *    key Mouth va Mouth2..8 nhung thieu Mouth1; Marco `viseme_0` thieu Mouth2
 *    va Mouth6. Bone khong duoc key o track 1 se roi ve track 0 (Idle), nen
 *    doi viseme co the thay bone giat nhe. Sua that nam o file Spine, khong
 *    sua duoc o day.
 *
 * 3. **Runtime khoa theo phien ban.** Skeleton export tu Spine 4.3.x chi nap
 *    duoc bang runtime 4.3.x. Nang cap editor ma quen nang npm la vo trang.
 */

import {
  AnimationState,
  AnimationStateData,
  AssetManager,
  AtlasAttachmentLoader,
  MeshAttachment,
  Physics,
  RegionAttachment,
  Skeleton,
  SkeletonBinary,
  SkeletonJson,
  SpineCanvas,
  Utils,
  type NumberArrayLike,
  type SpineCanvasApp,
  type TextureAtlas,
  type TrackEntry,
} from '@esotericsoftware/spine-webgl';

import { visemeAnimation, type VisemeId } from '../../shared/viseme.ts';

/** Track 0: song (Idle, Blink). Track 1: mieng. */
const TRACK_IDLE = 0;
const TRACK_MOUTH = 1;

/**
 * Thoi gian giao thoa giua hai khau hinh, giay.
 *
 * Mieng that khong nhay coc: khi phat /b/ trong "about", moi da chum lai tu
 * truoc do. Nhay tuc thoi nhin ra ngay la may — va voi nguoi dang tap bat
 * chuoc thi con day sai ca cach chuyen am. Truoc day viec nay do
 * `viseme-player.ts` lam bang noi suy trong so; gio giao cho Spine, vi no biet
 * noi suy tren chinh cac bone chu khong phai tren mot con so.
 */
const MOUTH_MIX_SEC = 0.07;

/** Le chua quanh skeleton khi phai om ca nguoi (khong tim thay bone dau). */
const VIEW_PADDING = 1.15;

/**
 * Slot nao thi tinh la "mat".
 *
 * KHONG dung bone ten `Head`: ca bon rig deu co bone do nhung no nam o world
 * (0,0), tuc la day skeleton chu khong phai khop co — day la rig ban than,
 * khong phai nguoi day du. Lay no lam moc thi khung om tron ca nguoi.
 *
 * Ten slot thi khong thong nhat giua cac rig (`Robot_Face`, `Macro_Face`,
 * `Prof_Face`, `Face`), nhung deu chua mot trong cac tu duoi. Do bang chinh
 * hinh ve la cach duy nhat khong phu thuoc vao quy uoc dat ten bone.
 */
const FACE_SLOT = /face|eye|mouth|tooth|touth|tongue/i;

/**
 * Khung nhin cao gap may lan khung mat.
 *
 * 1.0 la mat cham sat hai mep. Day len chut de con thay toc va vai — do bang
 * spine-core tren ca bon rig thi mat chiem 44–62% chieu cao ca nguoi, nen he so
 * nay dua khung ve khoang mot nua nguoi tro len.
 */
const FACE_VIEW_SCALE = 1.3;

export interface AvatarBundle {
  /** `.skel` (nhi phan, nho hon) hoac `.json`. */
  skeleton: string;
  atlas: string;
}

export class Avatar {
  readonly #canvas: HTMLCanvasElement;
  #spine: SpineCanvas | null = null;
  #skeleton: Skeleton | null = null;
  #state: AnimationState | null = null;
  #mouth: TrackEntry | null = null;
  #current: VisemeId | null = null;
  #visemeCount = 0;
  #view: { x: number; y: number; height: number } | null = null;
  #resizeObserver: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
  }

  /**
   * Tai skeleton va bat vong render. Nem neu tai hong — ben goi quyet dinh co
   * roi ve thanh do hay khong.
   */
  async load(bundle: AvatarBundle): Promise<void> {
    const skeletonData = await new Promise<{ skeleton: Skeleton; state: AnimationState }>(
      (resolve, reject) => {
        const app: SpineCanvasApp = {
          loadAssets: (canvas) => {
            canvas.assetManager.loadTextureAtlas(bundle.atlas);
            if (bundle.skeleton.endsWith('.json')) canvas.assetManager.loadJson(bundle.skeleton);
            else canvas.assetManager.loadBinary(bundle.skeleton);
          },

          initialize: (canvas) => {
            try {
              resolve(this.#build(canvas, bundle));
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          },

          update: (canvas, delta) => {
            const skeleton = this.#skeleton;
            const state = this.#state;
            if (!skeleton || !state) return;
            state.update(delta);
            state.apply(skeleton);
            skeleton.updateWorldTransform(Physics.update);
          },

          render: (canvas) => {
            const skeleton = this.#skeleton;
            if (!skeleton) return;
            canvas.clear(0, 0, 0, 0);
            canvas.renderer.begin();
            canvas.renderer.drawSkeleton(skeleton);
            canvas.renderer.end();
          },

          // AssetManager gom loi cua tung file; noi lai de biet file nao hong
          // chu khong chi biet "tai that bai".
          error: (_canvas, errors) => {
            reject(new Error(Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('; ')));
          },
        };

        this.#spine = new SpineCanvas(this.#canvas, { app });
      }
    );

    this.#skeleton = skeletonData.skeleton;
    this.#state = skeletonData.state;

    // Canvas la `width:100%` nen layout doi la khung nhin sai ty le. Panel ben
    // canh con thu vao/gian ra theo cac `<details>` quanh no, nen chuyen nay
    // xay ra ngay trong mot buoi hoc chu khong chi luc xoay man.
    const spine = this.#spine;
    if (spine && typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(() => this.#applyCamera(spine));
      this.#resizeObserver.observe(this.#canvas);
    }
  }

  #build(canvas: SpineCanvas, bundle: AvatarBundle): { skeleton: Skeleton; state: AnimationState } {
    const assets: AssetManager = canvas.assetManager;
    const atlas = assets.require(bundle.atlas) as TextureAtlas;
    const loader = new AtlasAttachmentLoader(atlas);

    const raw = assets.require(bundle.skeleton);
    const data = bundle.skeleton.endsWith('.json')
      ? new SkeletonJson(loader).readSkeletonData(raw as object)
      : new SkeletonBinary(loader).readSkeletonData(raw as Uint8Array);

    const skeleton = new Skeleton(data);
    this.#skeleton = skeleton;

    // mixDuration mac dinh 0 se lam moi lan doi viseme la mot cu nhay coc.
    const stateData = new AnimationStateData(data);
    stateData.defaultMix = MOUTH_MIX_SEC;
    const state = new AnimationState(stateData);
    this.#state = state;

    this.#visemeCount = data.animations.filter((a) => /^viseme_\d+$/.test(a.name)).length;

    // Idle dau tien tim thay. Khong co cung khong sao — avatar dung im van
    // nhep duoc, va do la mot trieu chung khac han "khong tai duoc".
    const idle = data.animations.find((a) => /^Idle/i.test(a.name));
    if (idle) state.setAnimation(TRACK_IDLE, idle.name, true);

    this.#frame(canvas, skeleton);
    return { skeleton, state };
  }

  /**
   * Dat camera vao MAT nhan vat.
   *
   * KHONG dung `renderer.resize(ResizeMode.Fit, w, h)`: nhanh Fit cua runtime
   * bo qua hai tham so world size, no chi giu lai ty le cua viewport DANG co.
   * Ma viewport dang co lai la `new OrthoCamera(canvas.width, canvas.height)`
   * doc luc dung SceneRenderer — the <canvas> khong dat thuoc tinh width/height
   * nen do la 300x150 mac dinh cua HTML. Ket qua: khung nhin ~150 don vi world
   * tren mot skeleton cao hang nghin, tuc la mot vet cat phong to dat giua
   * nguoi. Dat thang viewport la duong duy nhat noi duoc kich thuoc that.
   */
  #frame(canvas: SpineCanvas, skeleton: Skeleton): void {
    skeleton.setupPose();
    skeleton.updateWorldTransform(Physics.update);

    // Chot khung o TU THE GOC, mot lan. Do o tu the dang chay thi Idle keo dau
    // di vai chuc don vi moi frame, va khung nhin se tro theo.
    this.#view = this.#faceView(skeleton);
    this.#applyCamera(canvas);
  }

  /** Ap khung da chot len camera theo ty le canvas hien tai. */
  #applyCamera(canvas: SpineCanvas): void {
    const view = this.#view;
    if (!view) return;

    const { width: w, height: h } = this.#syncCanvasSize(canvas);
    const camera = canvas.renderer.camera;
    camera.position.x = view.x;
    camera.position.y = view.y;
    // Neo theo CHIEU CAO: khung ben canh bai hoc thi hep, neo theo chieu rong
    // se cat mat dau.
    camera.setViewport(view.height * (w / h), view.height);
    camera.update();
  }

  /**
   * Vung world can lot vao khung: uu tien cai mat.
   *
   * Om ca skeleton thi dung ve mat ky thuat nhung sai muc dich — day la app day
   * PHAT AM, thu nguoi hoc can nhin la cai mieng. Ca nguoi trong mot khung cao
   * 220px thi mieng con vai pixel, nhep hay khong cung khong ai thay.
   */
  #faceView(skeleton: Skeleton): { x: number; y: number; height: number } {
    const all = skeleton.getBoundsRect();
    const whole = {
      x: all.x + all.width / 2,
      y: all.y + all.height / 2,
      height: all.height * VIEW_PADDING,
    };

    const face = this.#slotBounds(skeleton, FACE_SLOT);
    // Rig khong khop slot mat nao: om ca nguoi. Nho van hon khong thay gi.
    if (!face || face.height < all.height * 0.05) return whole;

    return {
      x: face.x + face.width / 2,
      y: face.y + face.height / 2,
      height: face.height * FACE_VIEW_SCALE,
    };
  }

  /**
   * AABB cua rieng nhung slot khop `re`, o tu the dang duoc ve.
   *
   * Cung cach `Skeleton.getBounds` lam, chi khac o cho loc slot — runtime khong
   * mo ra duong nao de gioi han pham vi cua no.
   */
  #slotBounds(
    skeleton: Skeleton,
    re: RegExp
  ): { x: number; y: number; width: number; height: number } | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const temp: number[] = new Array(2);

    for (const slot of skeleton.drawOrder.appliedPose) {
      if (!slot.bone.active || !re.test(slot.data.name)) continue;

      const attachment = slot.appliedPose.attachment;
      let vertices: NumberArrayLike | null = null;

      if (attachment instanceof RegionAttachment) {
        vertices = Utils.setArraySize(temp, 8, 0);
        attachment.computeWorldVertices(
          slot,
          attachment.getOffsets(slot.appliedPose),
          vertices,
          0,
          2
        );
      } else if (attachment instanceof MeshAttachment) {
        const n = attachment.worldVerticesLength;
        vertices = Utils.setArraySize(temp, n, 0);
        attachment.computeWorldVertices(skeleton, slot, 0, n, vertices, 0, 2);
      }
      if (!vertices) continue;

      for (let i = 0; i < vertices.length; i += 2) {
        minX = Math.min(minX, vertices[i] ?? 0);
        minY = Math.min(minY, vertices[i + 1] ?? 0);
        maxX = Math.max(maxX, vertices[i] ?? 0);
        maxY = Math.max(maxY, vertices[i + 1] ?? 0);
      }
    }

    if (minX === Infinity) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Backing store cua canvas = kich thuoc CSS nhan devicePixelRatio.
   *
   * Truoc day viec nay di kem `renderer.resize()`, chay dung MOT lan luc nap.
   * Canvas thi `width:100%` nen doi theo layout, va man Retina thi DPR 2 — bo
   * qua la vua nhoe vua sai ty le.
   */
  #syncCanvasSize(canvas: SpineCanvas): { width: number; height: number } {
    const el = canvas.htmlCanvas;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(el.clientWidth * dpr));
    const height = Math.max(1, Math.round(el.clientHeight * dpr));

    if (el.width !== width || el.height !== height) {
      el.width = width;
      el.height = height;
    }
    canvas.gl.viewport(0, 0, width, height);
    return { width, height };
  }

  /** So animation `viseme_N` tim thay. 0 = rig khong co khau hinh nao. */
  get visemeCount(): number {
    return this.#visemeCount;
  }

  /**
   * Mo mot khau hinh. Goi khi viseme dang mo DOI, khong goi moi frame —
   * `setAnimation` lai cung mot animation se tua no ve dau.
   */
  playViseme(id: VisemeId, weight = 1): void {
    const state = this.#state;
    if (!state) return;

    if (id !== this.#current) {
      this.#current = id;
      this.#mouth = state.setAnimation(TRACK_MOUTH, visemeAnimation(id), true);
    }
    // Schwa xuong 0.55: alpha cua track lam dung viec "mo mieng nhe hon" ma
    // truoc day phai gia lap bang trong so morph target.
    if (this.#mouth) this.#mouth.alpha = weight;
  }

  dispose(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#spine?.dispose();
    this.#spine = null;
    this.#skeleton = null;
    this.#state = null;
    this.#mouth = null;
    this.#current = null;
    this.#view = null;
  }
}
