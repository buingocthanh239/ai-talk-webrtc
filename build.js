/**
 * Bien dich phan client. Server khong qua day — Node chay thang file .ts.
 *
 * Hai bundle rieng chu khong phai mot:
 *   main       — code ung dung, nap bang <script type="module">
 *   pcm-worklet — chay trong AudioWorkletGlobalScope, mot the gioi khac han
 *                 (khong co window, khong co DOM) va duoc nap bang URL qua
 *                 audioWorklet.addModule(). Gop chung vao main la hong.
 */
import * as esbuild from 'esbuild';

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2023',
  sourcemap: true,
  logLevel: 'info',
};

const builds = [
  { ...common, entryPoints: ['public/src/main.ts'], outfile: 'public/js/bundle.js' },
  { ...common, entryPoints: ['public/src/pcm-worklet.ts'], outfile: 'public/js/pcm-worklet.js' },
];

if (process.argv.includes('--watch')) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
  console.log('  esbuild: dang theo doi public/src…');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
