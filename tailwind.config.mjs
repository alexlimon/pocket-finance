/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#f0f1e8',      // warm sage-cream (muted, not limey)
          card:    '#f5f5ef',      // near-white with subtle warmth
          hover:   '#e4e7db',      // muted sage hover
          border:  '#c0cab2',      // dusty sage border
        },
        brand: {
          green:  '#65a30d',       // lime green (lime zest)
          yellow: '#d97706',       // golden caramel
          red:    '#dc626d',       // soft rose/coral
          blue:   '#0d9488',       // teal (complementary)
          lime:   '#84cc16',       // bright lime accent
          cocoa:  '#78716c',       // cocoa dust
        },
      },
      fontFamily: {
        sans: ['Inter var', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
