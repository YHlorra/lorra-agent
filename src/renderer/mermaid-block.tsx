import type { JSX } from 'react';
import { useEffect, useId, useState } from 'react';
import { useAppStore } from '@/lib/app-store';

/**
 * Mermaid 图渲染块。mermaid 是重量级依赖,走动态 import 使其不进主包
 * (计划要求);主题(浅/深)变化时重渲染;解析失败回退 <pre> 原样代码。
 */
export function MermaidBlock({ code }: { code: string }): JSX.Element {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const theme = useAppStore((s) => s.theme);
  const rawId = useId();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // 例外:模块是运行时加载的(体积控制),静态 import 会把 mermaid 打进主包。
        const mermaid = (await import('mermaid')).default;
        const themeName = document.documentElement.classList.contains('dark') ? 'dark' : 'default';
        // initialize 每次按当前主题重设;渲染失败时 mermaid.render 会抛错走 catch。
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: themeName });
        const id = `mmd-${rawId.replace(/:/g, '')}`;
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(rendered);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, rawId, theme]);

  if (failed) {
    return (
      <pre className="mermaid-fallback">
        <code>{code}</code>
      </pre>
    );
  }
  if (!svg) {
    return (
      <div className="mermaid" aria-busy="true">
        渲染图中…
      </div>
    );
  }
  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
