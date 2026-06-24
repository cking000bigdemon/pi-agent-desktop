---
template_id: variflight
label: 飞常准公司模板
category: brand
summary: 飞常准（飞友科技）公司品牌模板，深蓝主色 + 微软雅黑 + 文档化对外汇报视觉语言，适用于公司汇报、产品介绍、对外演示。
keywords: [飞常准, 飞友科技, 航空, 商务, 品牌, 公司]
primary_color: "#0048AA"
canvas_format: ppt169
replication_mode: fidelity
visual_fidelity: literal
source_pptx: examples/variflight/20260123-公司PPT中文模板（20260123） (1) 1.pptx
placeholders:
  01_cover: ["{{TITLE}}", "{{TITLE_LINE2}}", "{{SUBTITLE}}", "{{AUTHOR}}", "{{DATE}}"]
  02_toc: ["{{TOC_TITLE_01}}", "{{TOC_TITLE_02}}", "{{TOC_TITLE_03}}", "{{TOC_TITLE_04}}", "{{TOC_TITLE_05}}", "{{SECTION_PREVIEW_TITLE}}", "{{SECTION_PREVIEW_BODY}}"]
  02_chapter: ["{{CHAPTER_NUM}}", "{{CHAPTER_TITLE}}", "{{CHAPTER_SUBTITLE_EN}}"]
  02a_chapter_overlay: ["{{CHAPTER_LABEL}}", "{{SLOGAN_CN}}", "{{SLOGAN_EN}}"]
  02b_chapter_minimal: ["{{CHAPTER_NUM}}", "{{CHAPTER_TITLE}}", "{{CHAPTER_SUBTITLE_EN}}", "{{CHAPTER_DESCRIPTION}}"]
  03_content: ["{{PAGE_TITLE}}", "{{CONTENT_AREA}}", "{{SOURCE}}"]
  03a_content_charts: ["{{PAGE_TITLE}}", "{{LEFT_SUBTITLE}}", "{{LEFT_DESCRIPTION}}", "{{LEFT_CHART}}", "{{RIGHT_SUBTITLE}}", "{{RIGHT_DESCRIPTION}}", "{{RIGHT_CHART}}", "{{BOTTOM_INSIGHT}}"]
  03b_content_three_cards: ["{{PAGE_TITLE}}", "{{CARD_LABEL_01}}", "{{CARD_LABEL_02}}", "{{CARD_LABEL_03}}", "{{CHART_01}}", "{{CHART_02}}", "{{CHART_03}}", "{{BOTTOM_CHART}}"]
  03c_content_table_compare: ["{{PAGE_TITLE}}", "{{LEFT_SUBTITLE}}", "{{COL_HEAD_01}}", "{{COL_HEAD_02}}", "{{COL_HEAD_03}}", "{{COL_HEAD_04}}", "{{COL_HEAD_05}}", "{{LIST_TITLE}}", "{{LIST_ITEM_01}}", "{{LIST_ITEM_02}}", "{{LIST_ITEM_03}}", "{{LIST_ITEM_04}}", "{{LIST_ITEM_05}}", "{{RIGHT_TABLE_TITLE}}", "{{RIGHT_ITEM_01}}", "{{RIGHT_ITEM_02}}", "{{RIGHT_ITEM_03}}", "{{RIGHT_ITEM_04}}", "{{RIGHT_ITEM_05}}"]
  03d_content_circle_diagram: ["{{PAGE_TITLE}}", "{{LEFT_HEADLINE}}", "{{LEFT_BODY_01}}", "{{LEFT_BODY_02}}", "{{LEFT_BODY_03}}", "{{BUBBLE_01_LINE1}}", "{{BUBBLE_01_LINE2}}", "{{BUBBLE_02_LINE1}}", "{{BUBBLE_02_LINE2}}", "{{BUBBLE_03_LINE1}}", "{{BUBBLE_03_LINE2}}"]
  03e_content_hero_card: ["{{PAGE_TITLE}}", "{{TOP_SUBTITLE}}", "{{TOP_DESCRIPTION}}", "{{HERO_IMAGE}}", "{{CARD_01_KEYWORD}}", "{{CARD_01_LINE1}}", "{{CARD_01_LINE2}}", "{{CARD_01_LINE3}}", "{{CARD_02_KEYWORD}}", "{{CARD_02_LINE1}}", "{{CARD_02_LINE2}}", "{{CARD_02_LINE3}}", "{{CARD_03_KEYWORD}}", "{{CARD_03_LINE1}}", "{{CARD_03_LINE2}}", "{{CARD_03_LINE3}}", "{{BOTTOM_INSIGHT}}"]
  03f_content_photo_grid: ["{{PAGE_TITLE}}", "{{TOP_TITLE}}", "{{TOP_SUBTITLE}}", "{{BOTTOM_TITLE}}", "{{BOTTOM_SUBTITLE}}", "{{IMAGE_01}}", "{{IMAGE_02}}", "{{IMAGE_03}}", "{{IMAGE_04}}", "{{IMAGE_05}}", "{{IMAGE_06}}", "{{IMAGE_07}}"]
  04_ending: ["{{ENDING_TITLE_EN}}", "{{ENDING_TITLE_CN}}", "{{CONTACT_LABEL_NAME}}", "{{CONTACT_NAME}}", "{{CONTACT_LABEL_PHONE}}", "{{CONTACT_PHONE}}", "{{CONTACT_LABEL_ADDR}}", "{{CONTACT_ADDRESS}}", "{{ENDING_DECORATION}}"]
---

# 飞常准公司模板 - Design Specification

> 飞友科技公司品牌模板。基于公司提供的 `20260123-公司PPT中文模板.pptx` (34 张幻灯片 / 7 个版式 / 1 个母版) 以 fidelity + literal 模式重建，保留品牌色系、字体、构图骨架与 sprite-sheet 几何。

---

## I. Template Overview

| Property | Description |
| -------- | ----------- |
| **Template Name** | variflight (飞常准公司模板) |
| **Use Cases** | 公司对外汇报、产品介绍、商务演示、品牌物料 |
| **Design Tone** | 现代、商务、克制、品牌克制蓝 |
| **Theme Mode** | 浅色 (白底 + 深蓝品牌色重音) |
| **Replication Mode** | fidelity (保留原 PPTX 多版式) |
| **Visual Fidelity** | literal (像素级还原原 PPTX 几何与装饰) |

---

## II. Canvas Specification

| Property | Value |
| -------- | ----- |
| **Format** | Standard 16:9 |
| **Dimensions** | 1280 × 720 px |
| **viewBox** | `0 0 1280 720` |
| **Slide Size (EMU)** | 12,192,000 × 6,858,000 |

---

## III. Color Scheme

### Brand Palette (源自原 PPTX theme1.xml)

| Role | Value | Notes |
| ---- | ----- | ----- |
| **accent1 (品牌深蓝)** | `#0048AA` | 主色, 标题, 章节装饰块, icon |
| **accent2 (品牌橙)** | `#D76227` | 次重音色, 强调标签 |
| **accent3 (中蓝)** | `#366FC1` | 图表辅色 |
| **accent4 (亮蓝)** | `#2C68FF` | 渐变端点, hero 渐变 |
| **accent5 (灰蓝)** | `#667583` | 文字次要色 |
| **accent6 (浅灰蓝)** | `#9FA9B3` | 边框, 弱化色 |
| **dk1 (主文本)** | `#262626` | 主要正文 |
| **dk2 (灰文本)** | `#768395` | 次要正文 |
| **lt1 (白背景)** | `#FFFFFF` | 主背景 |
| **lt2 (浅灰背景)** | `#F0F0F0` | 卡片/卡背景 |
| **章节深蓝** | `#144484` | 封面/章节深底 |
| **TOC 卡片背景** | `#F1F3FA` | 目录页主卡 |

---

## IV. Typography System

| Font Family | Usage |
| ----------- | ----- |
| `Gadugi` | 拉丁字符 (theme.majorLatin / minorLatin) |
| `微软雅黑` | 中文 (theme.minorEastAsia) |
| `Poppins` (备选) | 部分英文标题，备选 fallback |

### Font Size Hierarchy

| Level | Usage | Size |
| ----- | ----- | ---- |
| H1 | 封面主标题 / 章节大编号 | 56 - 200 |
| H2 | 章节标题 / 结束页主标题 | 44 - 58 |
| H3 | 页面标题 / TOC 条目 | 26 - 32 |
| H4 | 卡片标题 / 章节副标题 | 22 - 24 |
| P | 正文 | 18 - 21 |
| Caption | 注释 / 数据源 | 12 - 14 |

---

## V. Core Design Principles

1. **品牌色重音克制**：深蓝 `#0048AA` 作为唯一主色调，橙 `#D76227` 仅在数据/警告类使用。
2. **顶部装饰条**：内容页统一以 36.69×51.13 的小蓝色块 + 顶部分隔线作为页眉骨架。
3. **右上角 sprite 装饰**：内容/章节页右上保留 corner_sprite 渐进式装饰图（sprite-sheet 裁剪保留）。
4. **白底为主**：所有非章节封面以白底 + 卡片浮层为主，章节页才使用深蓝/photo 背景。
5. **右下版权声明**：所有页面保留 `Copyright© 飞友科技. All rights reserved.` 灰色脚注 (master 继承)。
6. **占位符词汇**：本模板使用领域化占位符（如 `{{CHAPTER_NUM}}`, `{{BUBBLE_01_LINE1}}`, `{{CONTACT_NAME}}` 等），见 frontmatter 的 `placeholders:` 块。

---

## VI. Page Roster

| File | Page Type | Source Slides | Description |
| ---- | --------- | ------------- | ----------- |
| `01_cover.svg` | 封面 | slide 01 (layout 01) | 深蓝全屏 + 顶部公司 logo + 中央大标题 + 底部 image1 水波 + image3 横线装饰 |
| `02_toc.svg` | 目录 | slide 02 (layout 07) | 顶部深蓝渐变条 + "CONTENTS"/"目录" 标题 + 左侧 5 项 indexed TOC + 右侧章节预览 |
| `02_chapter.svg` | 章节封面 (主) | slide 04 (layout 02) | 背景 photo + 白色蒙层 90% + 对角深蓝渐变条 + 左侧小装饰块 + 章节编号/标题 |
| `02a_chapter_overlay.svg` | 章节封面 (深色覆盖变体) | slide 09 (layout 05) | 背景 photo + 深蓝 94% 蒙层 + 右上 sprite + 中央 logo + 双行 slogan |
| `02b_chapter_minimal.svg` | 章节封面 (极简变体) | slide 12 (layout 03) | 白底 + 巨大蓝色章节编号 + 蓝色分隔横线 + 中英双行标题 + 描述 + 右上 sprite |
| `03_content.svg` | 通用内容 | layout 03/04 base | 顶部蓝色装饰块 + 标题 + 分隔线 + 自由内容区 + 数据源脚注 |
| `03a_content_charts.svg` | 双图表+底部条 | slide 14 | 顶部标题 + 浮动白卡 + 左右两图表 + 底部蓝色渐变条 + 总结文案 |
| `03b_content_three_cards.svg` | 三栏图表卡 | slide 15 | 顶部蓝色渐变标签条 (3 标签) + 3 张图表卡 + 底部宽卡 |
| `03c_content_table_compare.svg` | 表格 + 图标列表对比 | slide 13 | 左侧条纹表格 + 5 项带圆点列表 + 右侧大卡片 5 行多色背景表格 |
| `03d_content_circle_diagram.svg` | 圆形信息图 | slide 23 | 同心圆装饰 + 3 个 bubble 圆 (中英文双行) + 装饰小点 + 左侧描述 |
| `03e_content_hero_card.svg` | 顶部主图 + 3 卡 | slide 20 | 右上主图 + 渐隐文本区 + 3 张白卡 (各带蓝色渐变 head + keyword + 多行) + 底部蓝条 |
| `03f_content_photo_grid.svg` | 6/7 图卡网格 | slide 26 | 上下两条品牌色渐变背景 + 顶部 3 横向卡 + 底部 4 纵向卡 (各带图片占位) |
| `04_ending.svg` | 结束/联系我们 | slide 08 (layout 06) | 主白卡 + 公司 logo + 双语标题 + 3 行联系人/电话/地址 (圆点+分隔线) + 装饰区 |

---

## VII. Assets Inventory

| File | Source | Usage |
| ---- | ------ | ----- |
| `assets/logo.png` | image2.png | 公司 logo (封面 + 结束页) |
| `assets/cover_bottom_wave.png` | image1.png | 封面底部水波/云装饰 |
| `assets/cover_footer_line.png` | image3.png | 封面底部横线装饰 |
| `assets/chapter_bg.jpeg` | image4.jpeg | 章节封面背景照片 |
| `assets/corner_sprite.png` | image5.png | 各内容/章节页右上角 sprite (sprite-sheet 裁剪) |
| `assets/slogan_logo.png` | image16.png | overlay 章节页中央 logo |

---

## VIII. Sprite-Sheet Preservation

本模板从原 PPTX 导入时，`image5.png` (corner_sprite) 是一张 sprite sheet — 在源 SVG 中通过 `<svg viewBox="0.03984 0 0.83444 0.90153">` 嵌套裁剪只显示左下角约 83.4% × 90.2% 区域。

凡使用 `assets/corner_sprite.png` 的模板页（`02a_chapter_overlay.svg`, `02b_chapter_minimal.svg`, `03_content.svg` 等），其 `<image>` 都包装在 `<svg viewBox="...">` 嵌套结构中以保留原始几何，**禁止**展平为直接 `<image x y width height>` 形式。

---

## IX. Conventions

- **占位符格式**：`{{NAME}}`，全部声明在 frontmatter 的 `placeholders:` 块，避免 svg_quality_checker `--template-mode` 警告。
- **版权脚注**：所有页面右下角统一 `Copyright© 飞友科技. All rights reserved.` 字号 14 灰色 `#808080` 或在深底页使用 `#FFFFFF` 70%。
- **页边距**：标准内容页左 60 / 右 60 / 顶 60 / 底 60；安全区 60–1220 × 60–660。
