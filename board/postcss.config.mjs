// Tailwind v4 ships its PostCSS plugin as a separate package and handles
// vendor prefixing itself (via Lightning CSS), so `autoprefixer` is no longer
// needed here. Named export clears eslint import/no-anonymous-default-export.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
