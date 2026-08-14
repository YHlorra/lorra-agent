import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTheme } from './lib/theme';
import './index.css';

// 窗口隐藏/被遮挡(远程桌面、虚拟显示、最小化)时 Chromium 冻结 requestAnimationFrame,
// 依赖 rAF 的库(epubjs 渲染队列等)会永久挂起。隐藏态降级为 setTimeout(≈60fps),
// 可见时仍走原生 rAF(帧同步不退化)。
if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
  const nativeRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    if (document.visibilityState === 'hidden') {
      return window.setTimeout(() => cb(performance.now()), 16);
    }
    return nativeRaf(cb);
  };
}

// 首帧前套上主题类,避免浅色闪白。
initTheme();

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');

createRoot(root).render(<App />);
