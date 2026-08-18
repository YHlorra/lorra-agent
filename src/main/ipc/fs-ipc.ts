import { readFile, stat } from 'node:fs/promises';
import { Result as ResultRuntime } from 'better-result';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { Annotation, AnnotationDraft } from '../../shared/annotations';
import type { SerializedResult } from '../../shared/result';
import { err, ok, toSerialized } from '../../shared/result';
import {
  loadAnnotations,
  relPathOf,
  removeAnnotation,
  saveAnnotation,
} from '../annotations/annotations-store';
import { resolveWikilinkFile, searchWorkspaceFiles } from '../fs/fs-search';
import { readFileContent, readTree, resolveId } from '../fs/path-resolve';
import { tMain } from '../i18n';
import { atomicWrite } from '../pi-sdk-driver/tool-safety/atomic-write';

/**
 * FS IPC reads the active workspace path through a getter rather than a
 * captured value — the runtime may switch workspaces after these handlers
 * are registered, and the renderer must see the new path on every call.
 */
export function registerFsHandlers(opts: { getActiveWorkspacePath: () => string | null }): void {
  ipcMain.handle(
    'lorra.fs.tree',
    async (
      _e,
      args: { directoryId: string; depth?: number },
    ): Promise<SerializedResult<unknown>> => {
      const ws = opts.getActiveWorkspacePath();
      if (!ws) {
        return toSerialized(err({ code: 'no-workspace', message: 'workspace not set' }));
      }
      return ResultRuntime.tryPromise({
        try: async () => readTree(args.directoryId, ws),
        catch: (cause) => ({
          code: 'fs-error',
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      }).then(toSerialized);
    },
  );

  // @ 文件引用候选:工作区文件名搜索,返回相对路径 fileId。
  ipcMain.handle(
    'lorra.fs.search',
    async (_e, args: { query: string; limit?: number }): Promise<SerializedResult<unknown>> => {
      const ws = opts.getActiveWorkspacePath();
      if (!ws) {
        return toSerialized(err({ code: 'no-workspace', message: 'workspace not set' }));
      }
      return ResultRuntime.tryPromise({
        try: async () => searchWorkspaceFiles(ws, args.query, args.limit),
        catch: (cause) => ({
          code: 'fs-error',
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      }).then(toSerialized);
    },
  );

  // 双链导航目标解析(2026-08-17):按文件名精确匹配,命中返回 fileId,未命中 null。
  ipcMain.handle(
    'lorra.fs.resolve-wikilink',
    async (_e, args: { name: string }): Promise<SerializedResult<unknown>> => {
      const ws = opts.getActiveWorkspacePath();
      if (!ws) {
        return toSerialized(err({ code: 'no-workspace', message: 'workspace not set' }));
      }
      return ResultRuntime.tryPromise({
        try: async () => ({ fileId: await resolveWikilinkFile(ws, args.name) }),
        catch: (cause) => ({
          code: 'fs-error',
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      }).then(toSerialized);
    },
  );

  ipcMain.handle(
    'lorra.fs.open',
    async (_e, args: { fileId: string }): Promise<SerializedResult<unknown>> => {
      const ws = opts.getActiveWorkspacePath();
      if (!ws) {
        return toSerialized(err({ code: 'no-workspace', message: 'workspace not set' }));
      }
      return ResultRuntime.tryPromise({
        try: async () => readFileContent(args.fileId, ws),
        catch: (cause) => ({
          code: 'fs-error',
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      }).then(toSerialized);
    },
  );

  ipcMain.handle(
    'lorra.fs.openBinary',
    async (_e, args: { fileId: string }): Promise<SerializedResult<unknown>> => {
      const ws = opts.getActiveWorkspacePath();
      if (!ws) {
        return toSerialized(err({ code: 'no-workspace', message: 'workspace not set' }));
      }
      const resolved = await resolveId(args.fileId, ws);
      if (!resolved.ok) {
        return toSerialized(
          err({ code: 'unknown-file', message: `cannot open: ${resolved.code}` }),
        );
      }
      return ResultRuntime.tryPromise({
        try: async () => ({ data: await readFile(resolved.realpath) }),
        catch: (cause) => ({
          code: 'fs-error',
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      }).then(toSerialized);
    },
  );

  ipcMain.handle(
    'lorra.fs.save',
    async (
      _e,
      args: { fileId: string; content: string; baseMtime?: number },
    ): Promise<SerializedResult<{ mtime: number }>> => {
      const ws = opts.getActiveWorkspacePath();
      if (!ws) {
        return toSerialized(
          err({ code: 'no-workspace', message: tMain('errors.fs.noActiveWorkspace') }),
        );
      }
      const resolved = await resolveId(args.fileId, ws);
      if (!resolved.ok) {
        return toSerialized(
          err({
            code: resolved.code,
            message: tMain('errors.fs.saveFailed', { code: resolved.code }),
          }),
        );
      }
      try {
        // mtime 守卫:编辑期间文件被其他来源改动 → 拒绝写入,由 renderer 重载磁盘版本。
        if (args.baseMtime !== undefined) {
          const st = await stat(resolved.realpath);
          if (st.mtimeMs !== args.baseMtime) {
            return toSerialized(
              err({
                code: 'file-changed',
                message: tMain('errors.fs.fileChanged'),
              }),
            );
          }
        }
        await atomicWrite(resolved.realpath, args.content);
        const after = await stat(resolved.realpath);
        return toSerialized(ok({ mtime: after.mtimeMs }));
      } catch (cause) {
        return toSerialized(
          err({
            code: 'save-failed',
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
    },
  );

  // ---- 划线/笔记(annotation)IPC ----
  // relPath 由主进程从 fileId 解析后回填,renderer 不传(同款)。

  ipcMain.handle(
    'lorra.annotations.list',
    async (_e, args: { fileId: string }): Promise<SerializedResult<Annotation[]>> => {
      const ws = opts.getActiveWorkspacePath();
      if (!ws) {
        return toSerialized(err({ code: 'no-workspace', message: 'workspace not set' }));
      }
      const resolved = await resolveId(args.fileId, ws);
      if (!resolved.ok) {
        return toSerialized(
          err({ code: 'unknown-file', message: `cannot resolve: ${resolved.code}` }),
        );
      }
      try {
        const rel = relPathOf(ws, resolved.absPath);
        const all = await loadAnnotations(ws);
        return toSerialized(ok(all.filter((a) => a.relPath === rel)));
      } catch (cause) {
        return toSerialized(
          err({
            code: 'fs-error',
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
    },
  );

  ipcMain.handle(
    'lorra.annotations.save',
    async (
      _e,
      args: { fileId: string; annotation: AnnotationDraft },
    ): Promise<SerializedResult<void>> => {
      const ws = opts.getActiveWorkspacePath();
      if (!ws) {
        return toSerialized(err({ code: 'no-workspace', message: 'workspace not set' }));
      }
      const resolved = await resolveId(args.fileId, ws);
      if (!resolved.ok) {
        return toSerialized(
          err({ code: 'unknown-file', message: `cannot resolve: ${resolved.code}` }),
        );
      }
      try {
        const ann: Annotation = {
          ...args.annotation,
          relPath: relPathOf(ws, resolved.absPath),
        };
        await saveAnnotation(ws, ann);
        return toSerialized(ok(undefined));
      } catch (cause) {
        return toSerialized(
          err({
            code: 'fs-error',
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
    },
  );

  ipcMain.handle(
    'lorra.annotations.remove',
    async (_e, args: { fileId: string; id: string }): Promise<SerializedResult<void>> => {
      const ws = opts.getActiveWorkspacePath();
      if (!ws) {
        return toSerialized(err({ code: 'no-workspace', message: 'workspace not set' }));
      }
      // fileId 仅用于校验存在性,失败同 unknown-file。
      const resolved = await resolveId(args.fileId, ws);
      if (!resolved.ok) {
        return toSerialized(
          err({ code: 'unknown-file', message: `cannot resolve: ${resolved.code}` }),
        );
      }
      try {
        await removeAnnotation(ws, args.id);
        return toSerialized(ok(undefined));
      } catch (cause) {
        return toSerialized(
          err({
            code: 'fs-error',
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
    },
  );

  // 素材消化文件选择(3b 6.13):系统文件对话框 → 绝对路径;取消 → null。
  // 不依赖工作区（素材可来自任意位置），消化侧再校验可读性。
  ipcMain.handle('lorra.fs.pick-file', async (): Promise<SerializedResult<string | null>> => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined;
      const result = await dialog.showOpenDialog(win ?? ({} as BrowserWindow), {
        title: '选择素材文件',
        properties: ['openFile'],
        filters: [
          {
            name: '文本 / Markdown',
            extensions: ['md', 'markdown', 'txt', 'json', 'log', 'yaml', 'yml'],
          },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) return toSerialized(ok(null));
      return toSerialized(ok(result.filePaths[0]));
    } catch (cause) {
      return toSerialized(
        err({
          code: 'pick-file-failed',
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
  });
}
