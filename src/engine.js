const warmup = 'A: English 中文 日本語 😀 👩‍💻 🇯🇵 👍🏽 1️⃣';

/** One SDK instance belongs to one Worker; packaged assets are the only font authority. */
export async function createEngine(dependencies) {
  const { initializeTextGraph, fontCatalogUrl } = dependencies ?? {
    ...(await import('@drawmotive/textgraph/node')),
    ...(await import('@drawmotive/textgraph-fonts')),
  };
  const runtime = await initializeTextGraph({
    fontAssets: { catalog: fontCatalogUrl, fallback: false },
    fetch: async () => { throw new Error('Network asset access is disabled.'); },
  });
  try {
    const required = ['textgraph-render-v1', 'textgraph-render-svg-v1', 'textgraph-fonts-v1'];
    if (typeof runtime.renderPng !== 'function' || typeof runtime.renderSvg !== 'function' || required.some(capability => !runtime.info.capabilities.includes(capability))) {
      const error = new Error('The installed TextGraph SDK must support native PNG, SVG and packaged fonts.');
      error.code = 'UNSUPPORTED_CAPABILITY';
      throw error;
    }
    for (const result of [await runtime.renderPng(warmup), await runtime.renderSvg(warmup)]) {
      if (!result.success || result.diagnostics.some(diagnostic => diagnostic.stage === 'font')) {
        const error = new Error('Packaged runtime and fonts could not be initialized.');
        error.code = 'WORKER_STARTUP_FAILED';
        throw error;
      }
    }
  } catch (error) {
    try { await runtime.dispose(); } catch { /* Preserve the initialization failure. */ }
    throw error;
  }
  return {
    async render(format, input) {
      const { source, ...options } = input;
      return format === 'png'
        ? runtime.renderPng(source, { ...options, encoding: 'bytes' })
        : runtime.renderSvg(source, options);
    },
  };
}
