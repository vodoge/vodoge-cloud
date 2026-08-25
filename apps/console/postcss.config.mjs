/**
 * Next.js picks this up automatically; adding it replaces Next's built-in
 * PostCSS chain, so autoprefixer has to be named explicitly — it is part of
 * the default chain and would otherwise be dropped.
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
