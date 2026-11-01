/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      // Width alone can't tell a touch phone from a laptop: the unfolded iPhone Duo is
      // ~890 CSS px wide, past `sm`. These key off the input device instead.
      screens: {
        'touch':     { raw: '(hover: none) and (pointer: coarse)' },
        'can-hover': { raw: '(hover: hover) and (pointer: fine)' },
        // Folded iPhone Duo (~466 CSS px wide): wider than any slab iPhone (Pro Max is 440)
        // and squat. The tab bar moves to a right-side rail to save height. Matched on width
        // OR shape, since the home-screen app has no toolbars and so is taller than Safari.
        'fold':      { raw: '(hover: none) and (pointer: coarse) and (min-width: 450px) and (max-width: 639px), (hover: none) and (pointer: coarse) and (max-width: 639px) and (min-aspect-ratio: 3/5)' },
      },
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
