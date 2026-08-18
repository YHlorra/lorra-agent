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
