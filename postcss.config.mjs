/**
 * Tailwind v4 ships its own PostCSS plugin; there is no `tailwind.config.js`
 * and no `autoprefixer` entry — both are handled inside `@tailwindcss/postcss`.
 * The design tokens live in `app/globals.css` instead of a JS config.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
