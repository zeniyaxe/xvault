/* Canonical X post-link transformation. Shared by every X.com injection. */
(() => {
  const providers = Object.freeze({
    fixvx: { label: 'FixVX', host: 'fixvx.com' },
    fixupx: { label: 'FixupX', host: 'fixupx.com' },
    fxtwitter: { label: 'FxTwitter', host: 'fxtwitter.com' },
    vxtwitter: { label: 'VXTwitter', host: 'vxtwitter.com' },
    x: { label: 'X', host: 'x.com' },
    twitter: { label: 'Twitter', host: 'twitter.com' },
  });
  const tracking = /^(utm_|ref$|ref_src$|s$|t$|cxt$|cn$)/i;
  function status(url, base = location.href) {
    try {
      const parsed = new URL(url, base);
      const match = parsed.pathname.match(/^\/([^/?#]+)\/status\/(\d+)(\/[^?#]*)?$/);
      if (!match) return null;
      return { handle: match[1], id: match[2], suffix: match[3] || '', query: parsed.searchParams };
    } catch {
      return null;
    }
  }
  function customHost(value) {
    try {
      const candidate = String(value || '').trim();
      if (!candidate) return null;
      const url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
      return url.hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  function providerHost(provider, settings = {}) {
    if (provider === 'custom') return customHost(settings.customLinkHost);
    return providers[provider]?.host || providers.fixvx.host;
  }
  function transform(url, settings = {}, provider = settings.linkProvider || 'fixvx') {
    const post = status(url);
    const host = providerHost(provider, settings);
    if (!post || !host) return null;
    const out = new URL(`https://${host}/${encodeURIComponent(post.handle)}/status/${post.id}${post.suffix}`);
    const preserve = settings.copyPreserveQuery === true || settings.copyStripTracking === false;
    if (preserve)
      for (const [key, value] of post.query)
        if (settings.copyStripTracking === false || !tracking.test(key)) out.searchParams.append(key, value);
    return out.href;
  }
  const root = typeof globalThis !== 'undefined' ? globalThis : window;
  root.XVaultLinks = Object.freeze({
    providers,
    status,
    customHost,
    providerHost,
    transform,
    label: provider => (provider === 'custom' ? 'Custom' : providers[provider]?.label || 'FixVX'),
  });
})();
