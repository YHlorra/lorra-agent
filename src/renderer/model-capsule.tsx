import { Check } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { useT } from './lib/i18n';
import { pushRecentModel, type RecentModel, readRecentModels } from './recent-models';

interface ModelCapsuleProps {
  /** 当前默认模型(高亮勾选);null = 无默认。 */
  current: { providerId: string; modelId: string } | null;
  /** 切换模型(App 层负责 setDefault + refresh)。 */
  onModelChanged: (providerId: string, modelId: string) => Promise<void>;
  /** 关闭胶囊(Esc / 选择后)。 */
  onClose: () => void;
}

/**
 * 内联模型切换胶囊仓(composer 下方模型名按钮触发):最上方搜索,中间最近使用
 * (最多 3 个,localStorage),下方按已配置供应商分组的全量模型清单。
 * 数据真相源 = SDK 运行时快照 getAvailable(有就是能用的)+ providers.list
 * (供应商显示名)——不写死清单。选中即 setDefault + 记最近 + 关仓。
 */
export function ModelCapsule({ current, onModelChanged, onClose }: ModelCapsuleProps): JSX.Element {
  const t = useT();
  const [available, setAvailable] = useState<ModelDto[]>([]);
  const [providerNames, setProviderNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    // 数据源 = getAvailable(有就是能用的,不含未配置供应商的全目录)。
    // 曾用 models.list({}) → 返回 SDK 全目录(1220 条/39 个未配置供应商),
    // 违背「已配置供应商分组」设计且撑爆列表;见 2026-08-19 修复。
    void Promise.all([window.lorra.models.getAvailable(), window.lorra.providers.list()])
      .then(([avail, con]) => {
        if (cancelled) return;
        setAvailable(avail.ok ? avail.value : []);
        const names: Record<string, string> = {};
        if (con.ok) for (const p of con.value) names[p.id] = p.name;
        setProviderNames(names);
      })
      .catch(() => {
        // 静默:胶囊打不开清单已是最差退化,不复位为错误态。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 最近使用:过滤掉已不在可用清单里的(供应商断开等),只留前 3。
  const recent = useMemo<RecentModel[]>(
    () =>
      readRecentModels()
        .filter((r) => available.some((m) => m.provider === r.providerId && m.id === r.modelId))
        .slice(0, 3),
    [available],
  );

  // 按已配置供应商分组的全量清单;组间按供应商显示名排序。
  const groups = useMemo(() => {
    const map = new Map<string, ModelDto[]>();
    for (const m of available) {
      const arr = map.get(m.provider) ?? [];
      arr.push(m);
      map.set(m.provider, arr);
    }
    return [...map.entries()]
      .map(([provider, models]) => ({ provider, models }))
      .sort((a, b) =>
        (providerNames[a.provider] ?? a.provider).localeCompare(
          providerNames[b.provider] ?? b.provider,
        ),
      );
  }, [available, providerNames]);

  const isCurrent = (providerId: string, modelId: string): boolean =>
    !!current && current.providerId === providerId && current.modelId === modelId;

  /** 选择模型:记最近 → 交 App 切换 → 关仓。 */
  async function select(providerId: string, modelId: string): Promise<void> {
    pushRecentModel({ providerId, modelId });
    await onModelChanged(providerId, modelId);
    onClose();
  }

  const modelName = (model: ModelDto): string => model.name || model.id;
  const renderItem = (uid: string, provider: string, model: ModelDto): JSX.Element => (
    <CommandItem
      key={uid}
      // 最近组与全量组可含同一模型:value 唯一(cmkd 要求),点哪条效果一致。
      // 搜索命中靠 keywords(模型名 + 供应商名),与唯一 value 解耦。
      value={`${uid}`}
      keywords={[modelName(model), providerNames[provider] ?? provider]}
      onSelect={() => void select(provider, model.id)}
      data-current={isCurrent(provider, model.id)}
      className={isCurrent(provider, model.id) ? 'model-capsule-item-current' : ''}
    >
      <span className="model-capsule-item-name">{modelName(model)}</span>
      <span className="model-capsule-item-provider">{providerNames[provider] ?? provider}</span>
      {isCurrent(provider, model.id) ? (
        <Check className="ml-auto h-4 w-4 shrink-0" aria-hidden="true" />
      ) : null}
    </CommandItem>
  );

  return (
    <Command className="model-capsule">
      <CommandInput autoFocus placeholder={t('composer.modelSearch')} />
      <CommandList>
        <CommandEmpty>{t('composer.modelNotFound')}</CommandEmpty>
        {recent.length > 0 && (
          <CommandGroup heading={t('composer.modelRecent')}>
            {recent.map((r) => {
              const model = available.find(
                (m) => m.provider === r.providerId && m.id === r.modelId,
              );
              if (!model) return null;
              return renderItem(`recent\0${r.providerId}\0${r.modelId}`, r.providerId, model);
            })}
          </CommandGroup>
        )}
        {recent.length > 0 && <CommandSeparator />}
        {groups.map((g) => (
          <CommandGroup key={g.provider} heading={providerNames[g.provider] ?? g.provider}>
            {g.models.map((m) => renderItem(`all\0${g.provider}\0${m.id}`, g.provider, m))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}
