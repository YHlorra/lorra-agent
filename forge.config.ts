import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';

const config: ForgeConfig = {
  packagerConfig: {
    // asar intentionally disabled: the Orca terminal host opens every freshly-created
    // .asar file and holds it without FILE_SHARE_DELETE, breaking electron-packager's
    // final move (EBUSY/EPERM on resources/app.asar). Unpacked app dir avoids it.
    asar: false,
    // LORRA_ELECTRON_ZIP_DIR: use a pre-patched Electron zip (default_app.asar removed).
    // Workaround for the same Orca locking on the template's default_app.asar.
    electronZipDir: process.env.LORRA_ELECTRON_ZIP_DIR || undefined,
    // lorra 应用图标(2026-08-18 用户指定:白发蓝瞳动漫少女,深蓝渐变圆角方底,
    // 全尺寸唯一来源,见 build/icon-source.jpg;不得更换为其他图片)。
    // 多尺寸 ICO:16/24/32/48/64/128/256 全来自同一源图,见 build/icon.ico。
    // 生成方式:python scripts/build-icon.py(依赖 PIL,无需新增 npm 原生包)。
    icon: 'build/icon.ico',
    // 复制整个 build 目录到 resources/build/,供 BrowserWindow icon
    // (createWindow)打包后读取 resources/build/icon.ico 使用。
    extraResource: ['build'],
  },
  makers: [new MakerSquirrel({})],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.ts' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
  ],
};

export default config;
