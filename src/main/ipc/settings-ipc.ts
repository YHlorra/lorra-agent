import { ipcMain } from 'electron';
import type { Lang } from '../../shared/i18n-core';
import type { SerializedResult } from '../../shared/result';
import { err, ok, toSerialized } from '../../shared/result';
import { setMainLanguage } from '../i18n';
import { readSettings, writeSettings } from '../workspace/settings';

/** 语义清洗模型形状(compileModel);与 AppSettings.compileModel 同构。 */
export interface CompileModelDto {
  providerId: string;
  modelId: string;
}

export interface DataSourcesDto {
  claudeCode: boolean;
  opencode: boolean;
  ohMyPi: boolean;
  workbuddy: boolean;
}

export interface SettingsGetDto {
  showHiddenFiles: boolean;
  language: Lang;
  defaultHideThinking: boolean;
  compileModel: CompileModelDto | null;
  dataSources: DataSourcesDto;
}

export interface SettingsSetArgs {
  showHiddenFiles?: boolean;
  language?: Lang;
  defaultHideThinking?: boolean;
  compileModel?: CompileModelDto | null;
  dataSources?: Partial<DataSourcesDto>;
}

/** dataSources 逐键 === true 才保留(白名单)。 */
function normalizeDataSources(value: Partial<DataSourcesDto>): DataSourcesDto {
  return {
    claudeCode: value.claudeCode === true,
    opencode: value.opencode === true,
    ohMyPi: value.ohMyPi === true,
    workbuddy: value.workbuddy === true,
  };
}

/**
 * 应用设置 IPC:文件树隐藏项开关的读写; 起扩展为
 * 含界面语言; 扩展 compileModel(语义清洗模型,null = 清除)。
 * 设置是 app 级(跨工作区),与 workspace/ipc.ts 的「最近工作区」同源
 * (同一 settings.json)。
 */
export function registerSettingsHandlers(): void {
  ipcMain.handle('lorra.settings.get', async (): Promise<SerializedResult<SettingsGetDto>> => {
    try {
      const settings = await readSettings();
      return toSerialized(
        ok({
          showHiddenFiles: settings.showHiddenFiles ?? false,
          language: settings.language ?? 'zh',
          defaultHideThinking: settings.defaultHideThinking ?? false,
          compileModel: settings.compileModel ?? null,
          dataSources: normalizeDataSources(settings.dataSources ?? {}),
        }),
      );
    } catch (cause) {
      return toSerialized(
        err({
          code: 'settings-error',
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
  });

  ipcMain.handle(
    'lorra.settings.set',
    async (_e, args: SettingsSetArgs): Promise<SerializedResult<void>> => {
      try {
        const current = await readSettings();
        if (args.language !== undefined) setMainLanguage(args.language);
        await writeSettings({
          ...current,
          ...(args.showHiddenFiles !== undefined ? { showHiddenFiles: args.showHiddenFiles } : {}),
          ...(args.language !== undefined ? { language: args.language } : {}),
          ...(args.defaultHideThinking !== undefined
            ? { defaultHideThinking: args.defaultHideThinking }
            : {}),
          ...(args.compileModel !== undefined
            ? { compileModel: isCompileModelDto(args.compileModel) ? args.compileModel : null }
            : {}),
          ...(args.dataSources !== undefined
            ? { dataSources: { ...(current.dataSources ?? {}), ...args.dataSources } }
            : {}),
        });
        return toSerialized(ok(undefined));
      } catch (cause) {
        return toSerialized(
          err({
            code: 'settings-error',
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
    },
  );
}

/** 非法形状落 null(测试:非法形状 → null)。 */
function isCompileModelDto(value: CompileModelDto | null): value is CompileModelDto {
  return (
    value !== null &&
    typeof value.providerId === 'string' &&
    value.providerId.length > 0 &&
    typeof value.modelId === 'string' &&
    value.modelId.length > 0
  );
}
