import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 全局测试隔离(根因修复):tests/main 任何测试都不可能触达生产 ~/.lorra。
 *
 * 机制:lorraConfigDir(src/main/pi-sdk-driver/lorra-config-dir.ts)在调用时读
 * process.env.LORRA_E2E_USERDATA;本 setup 由 vitest 在**测试文件加载前**执行,
 * 用 mkdtemp 建一个一次性临时目录并强制写入该 env。此后 main 侧任何建目录/写库
 * 的调用都落到临时目录,与生产隔离。各测试文件内的 vi.stubEnv 保留(双保险,不冲突)。
 */
const isolatedUserData = mkdtempSync(join(tmpdir(), 'lorra-test-userdata-'));
process.env.LORRA_E2E_USERDATA = isolatedUserData;
