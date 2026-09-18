/**
 * Preset dimensions and aspect ratios — data only, no DOM, no computation.
 *
 * Every number here is either quoted from the platform's own documentation or derived from a
 * published ratio limit, and each entry records which it is:
 *
 *   - `source`    a URL that was actually opened and read while writing this file.
 *   - `derived: true`  the pixel size is arithmetic on a published ratio (Instagram publishes
 *                 ratio limits, not pixel tables), so it must not be quoted back as if the
 *                 platform published it.
 *
 * The Instagram entries deliberately carry no URL. A guessed documentation link is worse than
 * an honest description, and `derived` says plainly that the number is computed.
 */

/** Resize targets, grouped so the select can render <optgroup>s. */
export const RESIZE_PRESETS = [
  {
    id: 'instagram-square',
    group: 'Instagram',
    label: 'Square post',
    width: 1080,
    height: 1080,
    ratio: '1:1',
    derived: true,
    source: 'Derived from Instagram\'s published feed aspect-ratio range (1.91:1 to 4:5).',
    note: 'The classic feed square.',
  },
  {
    id: 'instagram-portrait',
    group: 'Instagram',
    label: 'Portrait post',
    width: 1080,
    height: 1350,
    ratio: '4:5',
    derived: true,
    source: 'Derived from Instagram\'s published maximum portrait ratio of 4:5.',
    note: 'Takes the most vertical space in the feed.',
  },
  {
    id: 'instagram-landscape',
    group: 'Instagram',
    label: 'Landscape post',
    width: 1080,
    height: 566,
    ratio: '1.91:1',
    derived: true,
    source: 'Derived from Instagram\'s published maximum landscape ratio of 1.91:1.',
    note: 'Anything wider gets cropped by the feed.',
  },
  {
    id: 'instagram-story',
    group: 'Instagram',
    label: 'Story or reel',
    width: 1080,
    height: 1920,
    ratio: '9:16',
    derived: true,
    source: 'Derived from Instagram\'s published 9:16 story format.',
    note: 'Full-screen vertical.',
  },
  {
    id: 'youtube-thumbnail',
    group: 'YouTube',
    label: 'Video thumbnail',
    width: 3840,
    height: 2160,
    ratio: '16:9',
    derived: false,
    source: 'https://support.google.com/youtube/answer/72431',
    note: 'YouTube asks for 3840 x 2160 with a minimum width of 640.',
  },
  {
    id: 'youtube-shorts-cover',
    group: 'YouTube',
    label: 'Shorts cover',
    width: 2160,
    height: 3840,
    ratio: '9:16',
    derived: false,
    source: 'https://support.google.com/youtube/answer/72431',
    note: 'YouTube asks for 2160 x 3840 for Shorts, minimum height 640.',
  },
  {
    id: 'hd-1080p',
    group: 'General',
    label: 'Full HD (1080p)',
    width: 1920,
    height: 1080,
    ratio: '16:9',
    derived: false,
    source: 'Standard display resolution (1080p).',
    note: 'A safe default for screens and presentations.',
  },
  {
    id: 'web-1280',
    group: 'General',
    label: 'Web image (1280 wide)',
    width: 1280,
    height: 1280,
    ratio: null,
    derived: false,
    source: 'Conventional web content width.',
    note: 'Fits inside the box, so a landscape photo keeps its shape.',
  },
];

/**
 * Crop aspect ratios. `ratio` is width/height, or null for freeform.
 * These are ratios rather than pixel sizes, so there is nothing to source: 16:9 is 16:9.
 */
export const CROP_RATIOS = [
  { id: 'free', label: 'Free', ratio: null, note: 'Drag any rectangle.' },
  { id: 'square', label: '1:1', ratio: 1, note: 'Square — profile pictures and grid posts.' },
  { id: 'portrait', label: '4:5', ratio: 4 / 5, note: 'Portrait — the tallest the Instagram feed shows.' },
  { id: 'classic', label: '3:2', ratio: 3 / 2, note: 'Classic 35mm photo shape.' },
  { id: 'photo', label: '4:3', ratio: 4 / 3, note: 'Most phone cameras.' },
  { id: 'wide', label: '16:9', ratio: 16 / 9, note: 'Widescreen — thumbnails and slides.' },
];

/** Looks a preset up by id. Returns null for "no preset", so callers can pass a select value. */
export function findResizePreset(id) {
  return RESIZE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function findCropRatio(id) {
  return CROP_RATIOS.find((preset) => preset.id === id) ?? null;
}

/** The presets grouped in the order they appear above, for rendering an <optgroup> list. */
export function groupedResizePresets() {
  const groups = new Map();
  for (const preset of RESIZE_PRESETS) {
    if (!groups.has(preset.group)) groups.set(preset.group, []);
    groups.get(preset.group).push(preset);
  }
  return [...groups].map(([name, presets]) => ({ name, presets }));
}
