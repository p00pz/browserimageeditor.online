# COPY.md — مصدر النصوص الوحيد | Source of truth for all site copy

Applying agent: edit **only** the JSON keys and HTML paths cited below, then run `npm run gen` (it
rebuilds the generated nav/tool-card/footer partials from `content/*.json`). Never mix an old name
with a new one — one set, everywhere. Update the EN mirrors in `content/tools.json`,
`content/ui.json`, `content/pages.json` wherever an EN value appears below.

Build note: tool cards are rendered by `scripts/lib/tool-page.mjs:357-358` from `item.name` +
`item.description`. `name` is the SEO/breadcrumb/schema name and stays descriptive, so §1 adds two
keys per tool — `cardName`, `cardSubtitle` — and that one function must read
`item.cardName ?? item.name` / `item.cardSubtitle ?? item.description`. Related-tool cards and the
offline tool list inherit the change for free.

## 0. Voice rules

- Modern Standard Arabic, contemporary and confident. Short sentences. No literal translations, no
  calques, no «قم بـ», no «يرجى التكرم», no dialect.
- One verb set, site-wide: **تنزيل** = the visitor taking a file away (buttons, links, hints);
  **حفظ** = a file already landed on the device, or a browser-stored preference (theme);
  **تصدير** is banned — never use it. This overrides `content/ar/glossary.json -> download`
  («تحميل»), which is retired: the shipped UI already says تنزيل everywhere except the two
  «حمّل ملف PDF» strings fixed in §3/§4.
- No English script inside Arabic prose **except** format names (JPEG, JPG, PNG, WebP, AVIF, HEIC,
  HEIF, PDF, ZIP), size units (KB, MB, px) and — in parentheses only — proper names of algorithms,
  browsers and page sizes (Lanczos, Chrome, Edge, Firefox, Safari, A4, US Letter). **Web Worker /
  OffscreenCanvas / Canvas / WebAssembly are never written in Latin inside Arabic**: the concept is
  «مسار خلفي» (worker thread) / «خلفية المتصفح». This overrides the glossary's keepEnglish list.
- Western digits everywhere (0-9), never Arabic-Indic. A number with a **Latin** unit sits in
  `<bdi dir="ltr">…</bdi>` in HTML-injected strings only (templates, `ui.*` notes, `acceptHint`,
  which are injected raw via `{{{…}}}`). Never put `<bdi>` in `js.*` strings — they are all set with
  `textContent` and would render literally; there, keep number and unit adjacent and let the bidi
  algorithm handle it.
- Second person, masculine singular as neutral («أفلت صورة»), imperatives in UI, declarative in
  prose. Keep the glossary's one-term-one-word rule for everything else (صورة، ملف، صيغة، دفعة،
  مسار خلفي، تبويب، جهاز، خادم).

## 1. Final tool naming (navigation + UI cards) — the only set

| Tool | AR name (`navLabel` = `cardName`) | AR subtitle (`cardSubtitle`) | EN name | EN subtitle |
|---|---|---|---|---|
| compress | تخفيف | قلّل حجم صورك | Compress | Smaller files, same picture |
| resize | الأبعاد | غيّر العرض والارتفاع | Resize | Exact width and height |
| convert | الصيغة | بدّل بين JPEG وPNG وWebP | Convert | Switch between JPEG, PNG and WebP |
| crop | الإطار | اقتصّ وأعد التكوين | Crop | Trim and reframe |
| image-to-pdf | ملف PDF | اجمع صورك في ملف واحد | PDF | Combine images into one file |
| enhance-photo | لمسة | صقل الإضاءة والألوان | Enhance | Fix light and colour in one click |

Rationale — تخفيف: يحمل معنى تقليل الحجم، ويبتعد عن «الضغط» التي توحي بفعل فيزيائي وتُترجم حرفياً
من *compress*. الأبعاد: اسمٌ لما تغيّره فعلاً، أوضح من «المقاس» التي تلتبس بحجم الملف. الصيغة:
المعلومة الوحيدة التي يطلبها التحويل، فأوجز وأوضح من «التحويل». الإطار: هو ما ترسمه بيدك قبل
القص، فيصف التحديد لا الفعل، بينما «القص» تكرّر الفعل بلا دلالة. ملف PDF: الغاية ملف واحد، أوضح
من «صور إلى PDF» التي تصف الإجراء لا النتيجة. لمسة: التحسين بنقرة يبدو كأنه لمسة، أدفأ وأقل
إجرائية من «التحسين». EN keeps the familiar verbs; only PDF shortens, as its subtitle carries the
meaning. The six AR names are distinct in root and shape — no confusables.

Keys: `content/ar/tools.json -> tools[id].navLabel` for the six ids above (add `cardName`,
`cardSubtitle` to each object); same in `content/tools.json` (EN navLabel becomes `Compress`,
`Resize`, `Convert`, `Crop`, `PDF`, `Enhance`, with the EN `cardName`/`cardSubtitle` above).

## 2. SEO strings — descriptive terms stay in the SEO surface

Rule: the plain descriptive term (ضغط الصور، تغيير مقاس الصور، تحويل صيغة الصور، قص الصور، تحويل
الصور إلى PDF، تحسين الصور) is the **only** thing that may appear in `<title>`, meta description,
H1/H2 and body prose. The short names from §1 live in navigation, tool cards, buttons and status
lines. `name`, `title`, `description`, `h1`, `keywords`, `targetKeyword`, `faq` are therefore
untouched except the one value listed here: `content/ar/pages.json -> how-it-works.title`
«كيف يعمل — معالجة الصور داخل المتصفح مشروحة» → **«كيف يعمل — معالجة الصور داخل المتصفح»**.

Canonical per-tool values (AR `title` / AR `h1` in `content/ar/tools.json`; EN in
`content/tools.json` — EN already correct, restated so nothing drifts):

| Tool | AR title | AR h1 | EN title | EN h1 |
|---|---|---|---|---|
| compress | ضغط الصور عبر الإنترنت — مجاني وبلا رفع | اضغط صورتك دون رفعها | Compress Image Online — Private, No Upload | Compress an image without uploading it |
| resize | تغيير مقاس الصور — مجاني وبلا رفع | غيّر مقاس صورتك إلى الأبعاد التي تحتاجها | Resize Image Online — Free, Private, No Upload | Resize an image to the dimensions you need |
| convert | تحويل صيغة الصور — مجاني وبلا رفع | حوّل صورتك إلى صيغة أخرى | Convert Image Online — Private, No Upload | Convert an image to another format |
| crop | قص الصور عبر الإنترنت — مجاني وخاص وبلا رفع | اقتطع من صورتك الجزء الذي تريده | Crop Image Online — Free, Private, No Upload | Crop an image to the part you want |
| image-to-pdf | تحويل الصور إلى PDF — مجاني وخاص وبلا رفع | اجمع صورك في ملف PDF واحد | Image to PDF — Free, Private, No Upload | Turn images into a single PDF |
| enhance | تحسين الصور — خمسة أنماط بنقرة واحدة وبلا رفع | حسّن صورتك بنقرة واحدة | Photo Enhancer — 5 One-Click Styles, No Upload | Enhance a photo in one click |

## 3. Rewrite table (Arabic)

`content/ar/tools.json`:

- `tools.compress.intro` — «…يجري العمل داخل عامل ويب (Web Worker) في هذا التبويب…» → «أفلت صورة
  واحدة أو دفعة كاملة، وحدّد — إن أردت — الحجم المستهدف للملف. تجري المعالجة في مسار خلفي داخل
  التبويب فلا تتوقف الواجهة، ولا تغادر ملفاتك جهازك، وتنزل الدفعة الكاملة في ملف ZIP واحد.»
- `tools.enhance.intro` — «أفلت صورة، فتصحّح…ولا شيء يُرفع إلى أي مكان.» → «أفلت صورة لتصحّح
  الأداة سطوعها وانحرافها اللوني أولاً، ثم تعرض عليك خمسة أنماط مرسومة من صورتك أنت. اضبط شريط
  الشدة الواحد ونزّل النتيجة — بلا طبقات ولا منحنيات ولا حساب.» (privacy line already covers
  «لا شيء يُرفع»; keep `h1`/`title` as in §2.)

`content/ar/ui.json` (HTML-injected, so `<bdi>`/entities are safe):

- `ui.home.h1` — «أدوات صور لا ترفع ملفاتك أبداً» → **«أدوات صور لا ترفع ملفاتك»** (no orphan
  last word; breaks 3/2 on a phone).
- `ui.home.intro` — «كل أداة هنا تعمل داخل تبويب متصفحك أنت. تُعالَج…» → «كل أداة هنا تعمل داخل
  تبويب متصفحك. تُعالَج صورك على جهازك ولا تُرسَل إلى أي خادم — لأنه لا يوجد خادم أصلاً.»
- `ui.home.howP1` — «…على «عامل ويب» (Web Worker) مسارٍ خلفيٍّ…» → «تختار صورة من جهازك مباشرة،
  فتجري المعالجة كلها في مسار خلفي داخل التبويب — فك الترميز وتغيير المقاس وإعادة الترميز — دون
  أن تتوقف الواجهة. ثم يحفظ متصفحك الناتج على جهازك. لا شيء يُرفع، ولا شيء ينتظر في قائمة،
  وإغلاق التبويب ينهي الأمر كله.»
- `ui.shell.mb` — «ميغابايت» → **«MB»** (units stay Latin, per §0).
- `ui.shell.acceptHint` — «{formats} حتى {size}» → «{formats} حتى <bdi dir="ltr">{size}</bdi>»
- `ui.pdf.download` — «حمّل ملف PDF» → **«تنزيل ملف PDF»** (verb rule).
- `ui.compress.notesIntro` — «…على «عامل ويب» مسارٍ خلفيٍّ حيثما يوفّر متصفحك ذلك…» → «تجري
  المعالجة في مسار خلفي داخل هذا التبويب، فتبقى الصفحة مستجيبة أثناء العمل، ولا تصل ملفاتك إلى
  أي خادم. لا خادم خلفي ولا قائمة انتظار ولا حساب.»
- `ui.resize.notesIntro` — same robotic worker clause + «كما يحدث في التحجيم السريع بأقرب جار» →
  «يجري تغيير المقاس في مسار خلفي داخل هذا التبويب، فتبقى الصفحة مستجيبة، بمُرشّح إعادة معايرة
  (Lanczos) يحافظ على نعومة الحواف بدل الحواف المسنّنة التي ينتجها التحجيم السريع. ولا تصل
  الصورة إلى أي خادم.»
- `ui.convert.notesIntro` — → «تُفكّ ترميز الصورة وتُعاد رسمها وكتابتها في مسار خلفي داخل هذا
  التبويب، فتبقى الصفحة مستجيبة. لا شيء يُرفع، ولا حدّ لحجم الملف يفرضه خادم — لأنه لا خادم.»
- `ui.enhance.notesIntro` — → «تُقرأ الصورة وتُصحَّح وتُعالَج وتُكتب في مسار خلفي داخل هذا
  التبويب، فتبقى الصفحة مستجيبة. لا شيء يُرفع، وإغلاق الصفحة يمحو كل شيء.»
- `ui.crop.notesIntro` — → «تسحب التحديد فوق الصورة، ثم يُرسم القص ويُعاد ترميزه في مسار خلفي
  داخل هذا التبويب. الملف الأصلي لا يُعدَّل ولا يُرفع أبداً &mdash; القص ينتج ملفاً جديداً تنزّله.»
- `ui.pdf.notesIntro` — «…رزمةٌ من الأوراق الممسوحة ضوئياً…» → «يُجمَّع ملف PDF في مسار خلفي داخل
  هذا التبويب: تُلاءم كل صورة مع صفحتها وتُكتب في مستند واحد يحفظه متصفحك. حزمة من الأوراق
  الممسوحة ضوئياً لا تغادر جهازك أبداً.»
- `ui.enhance.intensityHint` — «…لأنه لا يوجد نمط للدمج معه.» → «مقدار قوة النمط: عند 0% تحصل على
  التصحيح التلقائي وحده، وعند 100% على النمط كاملاً. ويُعطَّل الشريط مع التحسين التلقائي لأنه
  لا توجد قوة للمزج.»
- `ui.crop.notes2` — «ودورة الربع تغيّر عرض الناتج وارتفاعه.» → «دوّر بخطوات 90&deg; واعكس عرضياً
  أو رأسياً إن كانت الصورة في الاتجاه الخطأ. والتدوير بربع دورة يبدّل عرض الناتج وارتفاعه.»
- `ui.compress.unsupported` / `ui.resize.unsupported` / `ui.convert.unsupported` /
  `ui.crop.unsupported` / `ui.pdf.unsupported` / `ui.enhance.unsupported` — the six near-identical
  notices; standardise on: «هذا المتصفح لا يستطيع [ضغط الصور / تغيير مقاس الصور / تحويل الصور /
  قص الصور / بناء ملف PDF / تحسين الصور] محلياً — تنقصه واجهة فك الترميز التي تقوم عليها هذه
  الأدوات. لا يُرفع أي شيء في كلتا الحالتين؛ جرّب نسخة حديثة من Chrome أو Edge أو Firefox أو
  Safari.» (only `ui.enhance.unsupported` currently deviates: «جرّب إصداراً حديثاً»).

`src/templates/ar/*.html` (static copy, edit in place — these are not generated):

- `src/templates/ar/home.html -> p.hero-eyebrow` — «بلا رفع ملفات. بلا خوادم. 100% على جهازك.» →
  **«بلا رفع ملفات — 100% على جهازك»** (one short line, no wrap).
- `src/templates/ar/home.html -> h1` — «أدوات صور لا ترفع ملفاتك أبداً» → **«أدوات صور لا ترفع
  ملفاتك»**; `p.hero-sub` → as `ui.home.intro` above; `p` (howP1) → as `ui.home.howP1` above.
- `src/templates/ar/pages/how-it-works.html` — «متصفحك أصلاً معالج صور قادر.» → «متصفحك أصلاً قادر
  على معالجة الصور.»; «مع «عامل ويب» (Web Worker) لتبقى الصفحة مستجيبة» → «مع مسار خلفي يُبقي
  الصفحة مستجيبة أثناء ذلك.»; «يستغرقان وقتاً واقعياً» → «يستغرقان وقتاً حقيقياً»; «وحيث تكون
  غائبة تقول الأداة ذلك وتتوقف، بدل أن تعود إلى تجميد الصفحة» → «وحيث تكون غائبة تخبرك الأداة
  وتتوقف، بدل أن تعود لتجميد الصفحة.»; «لا رفع، ولا قياسات، ولا خط أو شيفرة من جهة أخرى» →
  «لا رفع، ولا تحليلات، ولا خط أو شيفرة من جهة أخرى» («analytics» = تحليلات, not قياسات).
- `src/templates/ar/pages/privacy.html` — «لأن هذه الأدوات لا مكان لديها ترسلها إليه» → «لأن هذه
  الأدوات لا تملك مكاناً ترسلها إليه.»; «وهذه ليست وعداً عن سلوكنا عليك أن تأخذه على الثقة:
  الشيفرة المُصدَّرة لا تحتوي على أي طلب رفع أصلاً، فلا يوجد مسار شيفرة يمكن أن يرسل ملفاً.» →
  «وهذا ليس وعداً عليك أن تأخذه على الثقة: الشيفرة المُصدَّرة لا تحتوي على طلب رفع أصلاً، فلا
  يوجد مسار يمكن أن يُرسِل ملفاً.»
- `src/templates/ar/pages/terms.html` — voice only, substance untouched: «ومعالجة الصور تفقدان في
  مواضع» → «ومعالجة الصور تفقد في مواضع» (subject is singular). Everything else stays.
- `src/templates/ar/pages/contact.html` — «موقع يقوم كلّه على أن ملفاتك لا تُرفع لا ينبغي أن يجمع
  رسالتك بهذه الطريقة أيضاً.» → «موقع يقوم كلّه على أن ملفاتك لا تُرفع، لا ينبغي أن يجمع رسالتك
  بهذه الطريقة.»; «مزوّد بريدك ومزوّدنا ستكون لديهما نسخة أثناء النقل» → «سيكون لدى مزوّد بريدك
  ومزوّدنا نسخة أثناء النقل».
- `src/templates/ar/pages/offline.html` — «أفلت صورة، وشاهد النتيجة، وحمّلها.» → «أفلت صورة، وشاهد
  النتيجة، ونزّلها.»; «ولا جزء من الضغط أو… بناء PDF احتاج خادماً قط» → «ولا جزء من الضغط أو
  تغيير المقاس أو التحويل أو القص أو بناء PDF يحتاج إلى خادم»; «أداتان تجلبان برنامجاً في أول
  استخدام لهما» → «أداتان تنزّلان برنامجاً صغيراً في أول استخدام».
- `src/partials/ar/footer.html -> p.footer-tagline` — «بلا رفع ملفات. بلا تتبّع. 100% داخل جهازك.»
  → **«بلا رفع ملفات. بلا تتبّع. 100% على جهازك.»** (matches the chip; «داخل»→«على»).

## 4. Runtime UI strings (`js.*` — injected via `textContent`, so plain text, no markup)

- `js.error.INTERNAL` — «لم ينجح ذلك. لم يُرفع أي شيء؛ حاول مرة أخرى.» → «لم تنجح العملية. لم
  يُرفع أي شيء — حاول مرة أخرى.»
- `js.common.largerThanOriginal` — «خرج هذا الملف أكبر من الأصل…» → «الناتج أكبر من الأصل بمقدار
  {size} — جرّب WebP أو حدّد حجماً مستهدفاً.»
- `js.compress.nearTarget` — «قريب جداً: أكبر من هدفك…» → «اقتربنا كثيراً: الناتج أكبر من هدفك
  ({target}) بمقدار {over}، وهو أصغر ما تنتجه هذه الصورة.»
- `js.compress.unreachableTarget` — «لا يمكن الوصول إلى {target}…» → «تعذّر الوصول إلى {target}:
  أصغر ما تنتجه هذه الصورة هو {smallest}. قلّل أقصى عرض أو ارتفاع لتوفير أكثر.»
- `js.pdf.transcoded` / `js.pdf.transcodedOne` — broken grammar «لأن PDF يخزّن JPEG وPNG لا WebP»
  → «…لأن PDF يدعم JPEG وPNG فقط لا WebP.»
- `js.pdf.orderTooLong` — «…ليبقى في الذاكرة مرة واحدة» → «…وهذا عدد كبير من الصفحات للاحتفاظ بها
  في الذاكرة دفعة واحدة»
- `js.pdf.nothingToPut` — «لا يوجد شيء نضعه في ملف PDF.» → «لا توجد صور لوضعها في ملف PDF بعد.»
- `js.pdf.couldNotPrepareAll` — «لم نتمكن من تحضير أي من تلك الصور…» → «تعذّر تحضير أي صورة، فلا
  يوجد ما نُجمِّع منه ملف PDF.»
- `js.enhance.correctionApplied` — «مدّ التصحيح التلقائي كل قناة إلى المدى الكامل…» → «صحّحنا كل
  قناة لونية على حدة (معاملات {gains} للأحمر والأخضر والأزرق)، وكانت نقطتا الأسود {black}
  والأبيض {white}.» (same facts, human voice)- `js.enhance.manualPath` — «لا يدعم هذا المتصفح مرشّحات وحدة الرسوم…» → «هذا المتصفح لا يدعم
  مرشّحات الرسوم، فحُسب النمط بكسلاً بكسلاً بدل حسابه على شريحة الرسوم. الحساب مكافئ — لا
  يفترق المساران إلا ببضع قيم لونية — لكنه يستغرق وقتاً أطول قليلاً.»
- `js.enhance.zipTail` — «واستخدم زر ZIP لتنزيل الدفعة كاملة.» → « واستخدم «تنزيل الكل في ملف ZIP»
  للدفعة كاملة.» (quotes the real button label, like `js.compress.zipTail`).
- `js.pdf.downloadSize` — «حمّل ملف PDF ({size})» → **«تنزيل ملف PDF ({size})»** (verb rule).

Everything else in `content/ar/ui.json` is already natural — leave it. Keep especially
`js.webview.viewerHint`, `js.save.*`, the `js.dropzone.*` empty states, `js.common.zipReady*`,
`js.preset.*` (including «ستوري أو ريلز» — loanwords Arab readers actually use; do not recast them
as calques), and every `js.error.*` other than INTERNAL.

## 5. Home hero copy (AR + EN)

AR (`src/templates/ar/home.html`, mirrored in `content/ar/ui.json`):

- Chip: **«بلا رفع ملفات — 100% على جهازك»**
- H1: **«أدوات صور لا ترفع ملفاتك»** (5 words, breaks 3/2 — no orphan)
- Subhead: **«كل أداة هنا تعمل داخل تبويب متصفحك. تُعالَج صورك على جهازك ولا تُرسَل إلى أي خادم
  — لأنه لا يوجد خادم أصلاً.»**
- Body §1 (the Web Worker paragraph), in plain Arabic — workers mentioned only as «مسار خلفي»:
  «تختار صورة من جهازك مباشرة، فتجري المعالجة كلها في مسار خلفي داخل التبويب — فك الترميز وتغيير
  المقاس وإعادة الترميز — دون أن تتوقف الواجهة. ثم يحفظ متصفحك الناتج على جهازك. لا شيء يُرفع،
  ولا شيء ينتظر في قائمة، وإغلاق التبويب ينهي الأمر كله.»
- Body §2: unchanged (still accurate, reads well).

EN (`src/templates/home.html`): chip → **«No uploads — 100% on your device.»**; H1
«Image tools that never upload your files» stays (balanced, no orphan); subhead and both body
paragraphs stay as-is — the Web Worker sentence is natural in English.

## 6. Consistency checklist (run before shipping)

1. Verbs: تنزيل everywhere a file leaves the page; حفظ for the completed file / theme preference;
   zero occurrences of تصدير or حمّل as a download verb.
2. Zero Latin script inside Arabic prose except the allow-list in §0 — grep for `(Web Worker)`,
   `OffscreenCanvas`, `Canvas`, `WebAssembly` in `content/ar/*` and `src/templates/ar/*` must
   return nothing.
3. Descriptive SEO terms present in every `<title>`, meta description, H1 and body paragraph;
   short names only in nav, cards, buttons, status lines.
4. Western digits only; `<bdi dir="ltr">` around every Latin number+unit token in HTML strings;
   no markup anywhere in `js.*` strings.
5. One worker phrasing everywhere: «في مسار خلفي داخل هذا التبويب».
6. After edits: run `npm run gen` (rebuilds `src/partials/{ar,}/nav-*.html`, `tool-grid.html`,
   `nav-pages.html` and all `dist/` pages) — never hand-edit generated partials.
7. Once this review ships: set `content/ar/glossary.json -> reviewed: true` and drop
   `ui.chrome.translationNotice`, since the copy is no longer machine-translated.
