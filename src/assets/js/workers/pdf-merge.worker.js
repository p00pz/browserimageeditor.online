import { inspectMergeFiles, mergePdfFiles } from '../core/pdf-merge.js';

self.onmessage = async ({ data }) => {
  const progress = (ratio) => self.postMessage({ kind: 'progress', ratio });
  try {
    const result = data.operation === 'inspect'
      ? await inspectMergeFiles(data.files, data.existing, progress)
      : await mergePdfFiles(data.files, progress);
    self.postMessage({ kind: 'result', result });
  } catch (error) {
    self.postMessage({ kind: 'error', code: error.code ?? 'FAILED', fileName: error.fileName ?? '' });
  }
};
