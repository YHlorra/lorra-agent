/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Kami 紙 palette (design.md ). Semantic names: paper surfaces,
      // navy accent, ink text scale. 值均为 rgb 三元组 CSS 变量
      // （styles.css :root 定义）；`<alpha-value>` 让 /70 类透明度修饰符生效
      // （Tailwind v3.4 对裸 var 会静默丢弃透明度）。
      colors: {
        navy: 'rgb(var(--navy) / <alpha-value>)',
        'navy-light': 'rgb(var(--navy-light) / <alpha-value>)',
        paper: 'rgb(var(--paper) / <alpha-value>)',
        'paper-mid': 'rgb(var(--paper-mid) / <alpha-value>)',
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          secondary: 'rgb(var(--ink-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--ink-tertiary) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
        },
        line: {
          DEFAULT: 'rgb(var(--line) / <alpha-value>)',
          light: 'rgb(var(--line-light) / <alpha-value>)',
          accent: 'rgb(var(--line-accent) / <alpha-value>)',
        },
        overlay: 'rgb(var(--overlay) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
      },
      fontFamily: {
        // Kami 衬线气质:正文/标题走霞鹜文楷(LXGW WenKai),回退宋体系。
        // 映射到 sans 让 Tailwind preflight 的默认 body 直接用上。
        sans: [
          'LXGW WenKai',
          '"Noto Serif SC"',
          'Songti SC',
          'Georgia',
          'serif',
        ],
        mono: ['JetBrains Mono', '"SF Mono"', 'Consolas', 'monospace'],
      },
      borderRadius: {
        // Kami 圆角刻度:0 卡片 / 2 徽标 / 4 输入 / 6 导航 / 8 按钮 / 12 浮起卡
        kami: '4px',
        kamiSm: '2px',
        kamiLg: '12px',
      },
      boxShadow: {
        // Kami 阴影两级:raised + overlay(design.md )
        raised: 'rgba(20,19,19,0.08) 0px 8px 24px 0px',
        overlay: 'rgba(0,0,0,0.05) 0px 4px 24px 0px',
      },
      keyframes: {
        // BorderBeam(design.md .3):agent 工作时边框光束
        'border-beam': {
          '100%': { 'offset-distance': '100%' },
        },
      },
      animation: {
        'border-beam': 'border-beam var(--duration) infinite linear',
      },
    },
  },
  plugins: [],
}
