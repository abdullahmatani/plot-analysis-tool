/// <reference lib="webworker" />
// Placeholder until the DWG converter lands (row 22). Reports a clear, actionable message.
self.onmessage = () => {
  (self as unknown as Worker).postMessage({
    type: 'error',
    message:
      'DWG reading is not available in this build. Export the drawing as DXF or PDF from your CAD application.',
  });
};
