import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Result } from '../../shared/result';
import { ok } from '../../shared/result';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';
import type { MemoryStore } from './memory-store';

/**
 * 共享记忆存储单例(照 shared-facts-store.ts 结构):
 * 主进程所有消费方(today-ipc / memory-ipc / 复盘蒸馏 / 会话启动召回)统一经
 * getSharedMemoryStore 拿同一实例:单连接 + WAL + busy_timeout,消除多句柄并发写冲突。
 *
 * - 默认路径 ~/.lorra/memory/memory.db;也可显式传 dbPath(测试等场景),
 * 缓存按路径键控:同一路径返回同一实例,不同路径各开各的
 * - 内部自动 mkdir 父目录后 MemoryStore.open;首次失败不缓存
 * - MemoryStore 经动态 import(TLA 模块求值期装载,保持 getSharedMemoryStore
 * 同步签名):node:sqlite 是实验性内置(vitest 4 client 环境无法打包,Node 22
 * 的 builtinModules 不含 sqlite),静态 import 会把 sqlite 拉进 client 测试图
 */

const { MemoryStore: MemoryStoreImpl } = await import('./memory-store');

let cachedPath: string | null = null;
let cached: MemoryStore | null = null;

/**
 * getSharedMemoryStore 的返回类型:Result<MemoryStore> 且两变体都暴露 .value
 * (Err 上为 undefined)——测试契约要求裸访问 .value 可编译(isOk/isErr 窄化、
 * .error 访问均保留)。
 */
export type SharedMemoryStoreResult = Result<MemoryStore> & {
  readonly value: MemoryStore | undefined;
};

/**
 * 模块级单例:同一 dbPath 多次调用返回同一实例(引用相等)。
 * 省略 dbPath 时用默认 ~/.lorra/memory/memory.db。
 */
export function getSharedMemoryStore(dbPath?: string): SharedMemoryStoreResult {
  const resolved = dbPath ?? path.join(lorraConfigDir(), 'memory', 'memory.db');
  if (cached && cachedPath === resolved) return ok(cached);
  // MemoryStore.open 已自行 mkdir 父目录(契约:建库建表时父目录 recursive),
  // 此处再建一次幂等,保证目录缺失场景不依赖调用方。
  mkdirSync(path.dirname(resolved), { recursive: true });
  const opened = MemoryStoreImpl.open(resolved);
  if (opened.isOk()) {
    cached = opened.value;
    cachedPath = resolved;
  }
  // 运行时 Ok.value = 实例、Err.value = undefined(属性访问自然成立);
  // 类型上经交集补足 .value 后返回。
  return opened as SharedMemoryStoreResult;
}

/** 测试隔离:关闭并丢弃当前实例,下次调用返回新实例。 */
export function resetSharedMemoryStoreForTest(): void {
  if (cached) {
    try {
      cached.close();
    } catch {
      // close 失败无需再处理
    }
    cached = null;
    cachedPath = null;
  }
}
