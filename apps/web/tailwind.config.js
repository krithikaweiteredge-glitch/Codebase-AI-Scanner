/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Developer-tool palette: near-black surfaces, low-chroma borders,
        // one accent. Severity colours are the only saturated hues.
        canvas: '#0a0c10',
        surface: {
          DEFAULT: '#101319',
          raised: '#161a22',
          overlay: '#1c212b',
        },
        line: {
          DEFAULT: '#232833',
          strong: '#31384a',
        },
        ink: {
          DEFAULT: '#e6e9ef',
          muted: '#9aa4b8',
          faint: '#6b7488',
        },
        accent: {
          DEFAULT: '#4f8cff',
          hover: '#6b9dff',
          subtle: 'rgba(79,140,255,0.12)',
        },
        severity: {
          critical: '#f0506e',
          high: '#ff8a4c',
          medium: '#e5b447',
          low: '#4f8cff',
          info: '#8b93a7',
        },
        ok: '#3fb950',
        warn: '#d29922',
        danger: '#f0506e',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        md: '0.375rem',
        lg: '0.5rem',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'slide-up': 'slide-up 140ms ease-out',
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [],
};
