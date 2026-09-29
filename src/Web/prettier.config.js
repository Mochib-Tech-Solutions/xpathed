import shared from "../../.prettierrc.json" with { type: "json" };
import * as tailwindcss from "prettier-plugin-tailwindcss";

export default {
  ...shared,
  plugins: [tailwindcss],
  tailwindStylesheet: "./src/style.css",
};
