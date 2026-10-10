// A fresh worker per job releases parsed documents on success, failure and cancellation.
export function startPdfMergeJob(payload, onProgress) {
  const worker = new Worker(new URL('../workers/pdf-merge.worker.js', import.meta.url), { type: 'module' });
  let rejectJob;
  const promise = new Promise((resolve, reject) => {
    rejectJob = reject;
    worker.onmessage = ({ data }) => {
      if (data.kind === 'progress') { onProgress?.(data.ratio); return; }
      worker.terminate();
      if (data.kind === 'result') resolve(data.result);
      else reject(Object.assign(new Error(data.code), data));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      worker.terminate();
      reject(Object.assign(new Error('FAILED'), { code: 'FAILED' }));
    };
    worker.postMessage(payload);
  });
  return { promise, cancel() { worker.terminate(); rejectJob(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' })); } };
}
