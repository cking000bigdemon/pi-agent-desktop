// Rasterize build/icon.svg -> icon.png (+ helper sizes) using sharp from pi-web deps.
const path = require("path");
const fs = require("fs");
const ROOT = "D:\\variFlight_work\\pi-web-desktop";
const sharp = require(path.join(ROOT, "pi-web", "node_modules", "sharp"));
const buildDir = path.join(ROOT, "build");
const svg = fs.readFileSync(path.join(buildDir, "icon.svg"));

(async () => {
  for (const size of [1024, 512, 256]) {
    const out = size === 1024 ? "icon.png" : `icon-${size}.png`;
    await sharp(svg, { density: 512 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(buildDir, out));
    console.log("PNG_OK", out);
  }
})().catch((e) => {
  console.error("SHARP_FAIL", e && e.message);
  process.exit(3);
});
