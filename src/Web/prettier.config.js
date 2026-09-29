import shared from "../../.prettierrc.json" with { type: "json" };

export default {
  ...shared,
  plugins: ["prettier-plugin-tailwindcss"],
  tailwindStylesheet: "./src/style.css",
};
