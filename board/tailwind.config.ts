import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          900: "#0f1115",
          800: "#1a1d23",
          700: "#262a31",
          600: "#3a3f48",
          500: "#5c626d",
          400: "#8a909c",
          300: "#b0b5be",
          200: "#d6d9de",
          100: "#eceef1",
          50: "#f6f7f9",
        },
        lane: {
          urgent: "#e5484d",
          todo: "#f5a524",
          progress: "#8b5cf6",
          client: "#0ea5e9",
          done: "#10b981",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "Segoe UI",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
      },
      boxShadow: {
        card: "0 1px 2px rgba(15, 17, 21, 0.06), 0 1px 3px rgba(15, 17, 21, 0.04)",
      },
    },
  },
  plugins: [],
};

export default config;
