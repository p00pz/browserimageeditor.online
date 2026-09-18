/**
 * Number formatting shared by the UI layer.
 *
 * This lives outside dropzone.js because the compare slider and the tool both need
 * `formatBytes`; dropzone.js re-exports it, so nothing that imported it from there breaks.
 */

/** Human-readable byte size: "512 B", "96 KB", "2.4 MB". */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`;
  const megabytes = kilobytes / 1024;
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

/**
 * A savings percentage as it reads in a readout: smaller is "-96%", bigger is "+12%".
 * `estimateSavings` reports a positive percentage when the file shrank, which is why the
 * sign flips here rather than there.
 */
export function formatSignedPercent(percent) {
  if (!Number.isFinite(percent)) return '—';
  const rounded = Math.round(percent * 10) / 10;
  if (rounded === 0) return '0%';
  const magnitude = Math.abs(rounded);
  const value = Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(1);
  return `${rounded > 0 ? '-' : '+'}${value}%`;
}
