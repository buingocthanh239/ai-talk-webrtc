/**
 * Viseme — khau hinh mieng. Hop dong giua code va rig Spine.
 *
 * Bo 22 ID (0..21) la bo cua Azure Speech, KHONG phai vi ta dung Azure ma vi
 * **rig Spine cua cac nhan vat duoc ve theo bo do**: moi skeleton co dung 22
 * animation `viseme_0` … `viseme_21`. Ten animation la hop dong giua du lieu va
 * rig, nen bo ten phai theo rig.
 *
 * FILE NAY TUNG LON HON NHIEU. No tung chua bang doi tu 18 nhan viseme cua
 * Amazon Polly sang 22 ID cua rig, bo doc speech marks, va mot dong goi y tieng
 * Viet cho tung khau hinh. Tat ca deu phuc vu mot thu: nhep dung AM VI, lay tu
 * speech marks cua Polly.
 *
 * Duong do da bo. Avatar gio nhep FAKE tu bien do audio ngay tren may
 * (`public/src/fake-mouth.ts`) — mot request Polly moi khuc thay vi hai, va
 * khong con gi de doi tu nhan Polly sang ID rig. Lich su nam trong git; ly do
 * nam o dau `fake-mouth.ts`.
 *
 * Con lai o day dung nhung gi rig van doi hoi.
 */

/** Bo 22 khau hinh cua rig, danh so 0..21. 0 la im lang. */
export type VisemeId = number;

export const VISEME_IDS: readonly VisemeId[] = Array.from({ length: 22 }, (_, i) => i);

/** Ten animation tuong ung tren skeleton Spine. */
export const visemeAnimation = (id: VisemeId): string => `viseme_${id}`;
