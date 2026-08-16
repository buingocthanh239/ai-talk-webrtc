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
  Physics,
  ResizeMode,
  Skeleton,
  SkeletonBinary,
  SkeletonJson,
  SpineCanvas,
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

/** Chieu cao khung nhin theo don vi world cua skeleton. */
const VIEW_PADDING = 1.15;

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

  /** Dat camera om lay skeleton theo kich thuoc that cua no. */
  #frame(canvas: SpineCanvas, skeleton: Skeleton): void {
    skeleton.setupPose();
    skeleton.updateWorldTransform(Physics.update);

    const { x, y, width, height } = skeleton.getBoundsRect();
    const size = { x: width, y: height };

    const camera = canvas.renderer.camera;
    camera.position.x = x + width / 2;
    camera.position.y = y + height / 2;
    // Neo theo CHIEU CAO: nhan vat cao hon rong, va khung ben canh bai hoc
    // thi hep — neo theo chieu rong se cat mat dau.
    canvas.renderer.resize(ResizeMode.Fit, size.x * VIEW_PADDING, size.y * VIEW_PADDING);
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
    this.#spine?.dispose();
    this.#spine = null;
    this.#skeleton = null;
    this.#state = null;
    this.#mouth = null;
    this.#current = null;
  }
}
