/**
 * Cau hinh Amazon Polly.
 *
 * File nay KHONG goi Polly. Server khong con doc cau nao ca — moi request toi
 * Polly deu do client tu ky va tu goi (`public/src/polly-client.ts`), vi khuc
 * dau tien cua moi luot la toan bo do tre nguoi dung cam thay va mot vong
 * round trip qua backend nam dung tren duong nong do.
 *
 * Cai con lai o day chi la doc env: giong/engine mac dinh va region, cả ba
 * duoc dong goi vao `PollyGrant` gui xuong client cung credential tam
 * (`sts.ts`).
 */

import type { PollyEngine } from '../shared/types.ts';

// Engine di ca sang client (trong PollyGrant) nen kieu nam o shared.
export type { PollyEngine };

export interface PollyConfig {
  region: string;
  voiceId: string;
  engine: PollyEngine;
}

/** Engine `generative` khong nam trong day: no khong tra speech marks. */
const ENGINES: readonly string[] = ['standard', 'neural', 'long-form'];

/**
 * Doc cau hinh tu env. null = chua bat Polly, va khi do AI se hien chu nhung
 * khong co tieng — day la tinh nang phu, khong phai duong song, nen no tu tat
 * thay vi lam sap server.
 *
 * Dung lai region cua S3 khi khong khai rieng: cung mot tai khoan AWS, khong
 * co ly do bat nguoi cau hinh khai hai lan. Con credential thi hoan toan khong
 * doc o day — server khong ky gi cho Polly nua, viec do thuoc ve `sts.ts`.
 */
export function pollyConfigFromEnv(env = process.env): PollyConfig | null {
  if ((env.POLLY ?? 'off') !== 'on') return null;

  const engine = env.POLLY_ENGINE ?? 'neural';
  if (!ENGINES.includes(engine)) {
    throw new Error(
      `POLLY_ENGINE="${engine}" khong hop le. Chi ${ENGINES.join(', ')} — ` +
        'engine generative khong tra speech marks nen khong dung duoc o day.'
    );
  }

  const region = env.POLLY_REGION ?? env.S3_REGION ?? '';
  if (!region) {
    throw new Error('POLLY=on nhung thieu POLLY_REGION (hoac S3_REGION). Xem .env.example.');
  }

  return {
    region,
    // Chi la diem xuat phat: nguoi hoc doi giong ngay tren man hoc va lua chon
    // do duoc nho trong localStorage, nen bien nay chi con quyet dinh cho ai
    // chua tung chon.
    voiceId: env.POLLY_VOICE ?? 'Joanna',
    engine: engine as PollyEngine,
  };
}
